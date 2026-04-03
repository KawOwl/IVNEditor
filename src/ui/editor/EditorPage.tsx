/**
 * EditorPage — 多文档编剧编辑器
 *
 * 布局：
 *   - 左侧：文件侧栏（上传、文件列表）+ CodeMirror 编辑器
 *   - 右侧：tab 切换 —「Prompt 预览」/「试玩」/「调试」
 *
 * 每个上传的 .md 文件作为一个 PromptSegment，编剧可配置：
 *   - role (system / context)
 *   - priority
 *   - injectionRule（条件表达式）
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useAppStore } from '../../stores/app-store';
import { CodeEditor } from './CodeEditor';
import { EditorDebugPanel } from './EditorDebugPanel';
import { PromptPreviewPanel } from './PromptPreviewPanel';
import { PlayPanel } from '../play/PlayPanel';
import { LLMSettingsPanel } from '../settings/LLMSettingsPanel';
import { ScriptInfoPanel } from './ScriptInfoPanel';
import { estimateTokens } from '../../core/memory';
import { ScriptStorage, exportScript, parseImportedScript } from '../../storage/script-storage';
import type { ScriptRecord, ScriptListItem } from '../../storage/script-storage';
import { getEngineMode, getBackendUrl } from '../../core/engine-mode';
import { useAuthStore } from '../../stores/auth-store';
import { cn } from '../../lib/utils';
import { uuid } from '../../lib/uuid';
import type {
  ScriptManifest,
  PromptSegment,
  StateSchema,
  MemoryConfig,
  FlowGraph,
  SegmentRole,
} from '../../core/types';
import type { StateVarInfo } from '../../core/editor/completion-sources';

// ============================================================================
// Document model
// ============================================================================

interface EditorDocument {
  id: string;
  filename: string;
  content: string;
  role: SegmentRole;
  priority: number;
  injectionCondition: string;   // empty = always inject
  injectionDescription: string;
}

function createDocId(): string {
  return 'doc-' + Math.random().toString(36).slice(2, 8);
}

function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < Math.min(text.length, 1000); i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function docToSegment(doc: EditorDocument): PromptSegment {
  return {
    id: doc.id,
    label: doc.filename,
    content: doc.content,
    contentHash: simpleHash(doc.content),
    type: 'logic',
    sourceDoc: doc.filename,
    role: doc.role,
    priority: doc.priority,
    injectionRule: doc.injectionCondition
      ? { description: doc.injectionDescription || doc.injectionCondition, condition: doc.injectionCondition }
      : undefined,
    tokenCount: estimateTokens(doc.content),
  };
}

/** Convert a ScriptManifest's segments into EditorDocuments (deduplicated by segment ID) */
function manifestToDocuments(manifest: ScriptManifest): EditorDocument[] {
  const seen = new Set<string>();
  const docs: EditorDocument[] = [];
  for (const chapter of manifest.chapters) {
    for (const seg of chapter.segments) {
      if (seen.has(seg.id)) continue;
      seen.add(seg.id);
      docs.push({
        id: seg.id,
        filename: seg.sourceDoc || seg.label,
        content: seg.content,
        role: seg.role,
        priority: seg.priority,
        injectionCondition: seg.injectionRule?.condition ?? '',
        injectionDescription: seg.injectionRule?.description ?? '',
      });
    }
  }
  return docs;
}

// ============================================================================
// Default state schema
// ============================================================================

const defaultStateSchema: StateSchema = {
  variables: [
    { name: 'chapter', type: 'number', initial: 1, description: '当前章节' },
    { name: 'stage', type: 'number', initial: 1, description: '当前阶段序号' },
  ],
};

// ============================================================================
// Script Storage singleton
// ============================================================================

const scriptStorage = new ScriptStorage();

const defaultMemoryConfig: MemoryConfig = {
  contextBudget: 200000,
  compressionThreshold: 160000,
  recencyWindow: 10,
};

// ============================================================================
// Right panel tab type
// ============================================================================

type RightTab = 'prompt' | 'play' | 'debug' | 'settings' | 'info';

// ============================================================================
// Remote script merging types
// ============================================================================

type ScriptSource = 'local' | 'remote' | 'both';

interface MergedScriptItem extends ScriptListItem {
  source: ScriptSource;
  localVersion?: string;
  remoteVersion?: string;
  newerOnServer?: boolean;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// ============================================================================
// EditorPage
// ============================================================================

export function EditorPage() {
  const goHome = useAppStore((s) => s.goHome);

  // --- Multi-document state ---
  const [documents, setDocuments] = useState<EditorDocument[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [rightTab, setRightTab] = useState<RightTab>('prompt');
  const [initialPrompt, setInitialPrompt] = useState('开始测试');
  const [stateSchema, setStateSchema] = useState<StateSchema>(defaultStateSchema);
  const [memoryConfig, setMemoryConfig] = useState<MemoryConfig>(defaultMemoryConfig);
  const [enabledTools, setEnabledTools] = useState<string[]>(['read_state', 'query_changelog', 'pin_memory', 'query_memory', 'set_mood']);
  const [loadedScriptId, setLoadedScriptId] = useState<string | null>(null);
  const [scriptLabel, setScriptLabel] = useState('未命名剧本');
  const [scriptDescription, setScriptDescription] = useState('');
  const [scriptVersion, setScriptVersion] = useState('0.0.0');
  const [scriptTags, setScriptTags] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // --- Script library state ---
  const [scriptList, setScriptList] = useState<MergedScriptItem[]>([]);
  const [showScriptLibrary, setShowScriptLibrary] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [isPublished, setIsPublished] = useState(false);
  const [promptAssemblyOrder, setPromptAssemblyOrder] = useState<string[] | undefined>(undefined);

  const selectedDoc = documents.find((d) => d.id === selectedDocId) ?? null;

  // --- Load script list: local + remote merge ---
  const refreshScriptList = useCallback(async () => {
    const localList = await scriptStorage.list();

    // Remote mode + admin: also fetch server catalog
    if (getEngineMode() === 'remote' && useAuthStore.getState().isAdmin) {
      try {
        const authHeader = useAuthStore.getState().getAuthHeader();
        const res = await fetch(`${getBackendUrl()}/api/scripts/catalog`, { headers: authHeader });
        if (res.ok) {
          const remoteCatalog: Array<{ id: string; label: string; description?: string; tags?: string[]; version?: string; chapterCount: number }> = await res.json();

          const merged: MergedScriptItem[] = [];
          const seenIds = new Set<string>();

          // Process local items first
          for (const local of localList) {
            const remote = remoteCatalog.find((r) => r.id === local.id);
            if (remote) {
              // Exists on both sides
              const lv = local.version ?? '0.0.0';
              const rv = remote.version ?? '0.0.0';
              merged.push({
                ...local,
                source: 'both',
                localVersion: lv,
                remoteVersion: rv,
                newerOnServer: compareVersions(rv, lv) > 0,
              });
            } else {
              // Local only
              merged.push({ ...local, source: 'local' });
            }
            seenIds.add(local.id);
          }

          // Process remote-only items
          for (const remote of remoteCatalog) {
            if (seenIds.has(remote.id)) continue;
            merged.push({
              id: remote.id,
              label: remote.label,
              description: remote.description ?? '',
              updatedAt: Date.now(),
              fileCount: remote.chapterCount,
              tags: remote.tags,
              version: remote.version,
              source: 'remote',
              remoteVersion: remote.version,
            });
          }

          setScriptList(merged);
          return;
        }
      } catch {
        // Fall through to local-only
      }
    }

    // Local-only mode or fetch failed
    setScriptList(localList.map((l) => ({ ...l, source: 'local' as ScriptSource })));
  }, []);

  useEffect(() => {
    refreshScriptList();
  }, [refreshScriptList]);

  // --- Load a script (local or from server) ---
  const handleLoadScript = useCallback(async (scriptId: string) => {
    // Find merged item to check source
    const mergedItem = scriptList.find((s) => s.id === scriptId);
    const needsFetch = mergedItem && (mergedItem.source === 'remote' || mergedItem.newerOnServer);

    // If remote-only or server has newer version, fetch from server first
    if (needsFetch && getEngineMode() === 'remote') {
      try {
        const authHeader = useAuthStore.getState().getAuthHeader();
        const res = await fetch(`${getBackendUrl()}/api/scripts/${scriptId}`, { headers: authHeader });
        if (res.ok) {
          const serverRecord: ScriptRecord = await res.json();
          // Save to local IndexedDB
          await scriptStorage.save(serverRecord);
          await refreshScriptList();
        }
      } catch {
        // If fetch fails, try loading from local
      }
    }

    const record = await scriptStorage.get(scriptId);
    if (!record) return;

    const manifest = record.manifest;
    const docs = manifestToDocuments(manifest);
    setDocuments(docs);
    setSelectedDocId(docs.length > 0 ? docs[0]!.id : null);
    setStateSchema(manifest.stateSchema);
    setMemoryConfig(manifest.memoryConfig);
    setEnabledTools(manifest.enabledTools);
    setInitialPrompt(manifest.initialPrompt ?? '开始测试');
    setLoadedScriptId(scriptId);
    setScriptLabel(record.label);
    setScriptDescription(record.description);
    setScriptVersion(manifest.version ?? '0.0.0');
    setScriptTags(manifest.tags ?? []);
    setIsPublished(!!record.published);
    setPromptAssemblyOrder(manifest.promptAssemblyOrder);
    setShowScriptLibrary(false);
  }, [scriptList, refreshScriptList]);

  // --- Save current editor state to IndexedDB ---
  const handleSaveScript = useCallback(async () => {
    setSaving(true);
    try {
      const id = loadedScriptId ?? uuid();
      // Auto-increment patch version
      const vParts = scriptVersion.split('.').map(Number);
      const newVersion = `${vParts[0] || 0}.${vParts[1] || 0}.${(vParts[2] || 0) + 1}`;
      setScriptVersion(newVersion);

      const flowGraph: FlowGraph = { id: 'draft-flow', label: '草稿', nodes: [], edges: [] };
      const manifest: ScriptManifest = {
        id,
        version: newVersion,
        label: scriptLabel,
        description: scriptDescription,
        tags: scriptTags.length > 0 ? scriptTags : undefined,
        stateSchema,
        memoryConfig,
        enabledTools,
        initialPrompt: initialPrompt || undefined,
        promptAssemblyOrder: promptAssemblyOrder,
        chapters: [{
          id: 'ch1',
          label: '第一章',
          flowGraph,
          segments: documents.map(docToSegment),
        }],
      };

      const now = Date.now();
      const existing = await scriptStorage.get(id);
      const record: ScriptRecord = {
        id,
        label: scriptLabel,
        description: scriptDescription,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        manifest,
      };

      await scriptStorage.save(record);
      setLoadedScriptId(id);
      await refreshScriptList();
    } finally {
      setSaving(false);
    }
  }, [loadedScriptId, scriptLabel, scriptDescription, scriptVersion, scriptTags, stateSchema, memoryConfig, enabledTools, initialPrompt, documents, promptAssemblyOrder, refreshScriptList]);

  // --- Delete a script from IndexedDB ---
  const handleDeleteScript = useCallback(async (id: string) => {
    await scriptStorage.delete(id);
    if (loadedScriptId === id) {
      setLoadedScriptId(null);
      setDocuments([]);
      setSelectedDocId(null);
      setScriptLabel('未命名剧本');
      setScriptDescription('');
    }
    await refreshScriptList();
  }, [loadedScriptId, refreshScriptList]);

  // --- Rename a saved script ---
  const handleRenameScript = useCallback(async (id: string, newLabel: string) => {
    await scriptStorage.rename(id, newLabel);
    if (loadedScriptId === id) {
      setScriptLabel(newLabel);
    }
    await refreshScriptList();
  }, [loadedScriptId, refreshScriptList]);

  // --- Export current script as .ivn.json ---
  const handleExportScript = useCallback(async () => {
    // Build record from current state
    const id = loadedScriptId ?? 'export';
    const flowGraph: FlowGraph = { id: 'draft-flow', label: '草稿', nodes: [], edges: [] };
    const manifest: ScriptManifest = {
      id,
      version: scriptVersion,
      label: scriptLabel,
      description: scriptDescription,
      tags: scriptTags.length > 0 ? scriptTags : undefined,
      stateSchema,
      memoryConfig,
      enabledTools,
      initialPrompt: initialPrompt || undefined,
      promptAssemblyOrder: promptAssemblyOrder,
      chapters: [{
        id: 'ch1',
        label: '第一章',
        flowGraph,
        segments: documents.map(docToSegment),
      }],
    };

    const now = Date.now();
    const record: ScriptRecord = {
      id,
      label: scriptLabel,
      description: scriptDescription,
      createdAt: now,
      updatedAt: now,
      manifest,
    };

    const json = exportScript(record);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${scriptLabel}.ivn.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [loadedScriptId, scriptLabel, scriptDescription, stateSchema, memoryConfig, enabledTools, initialPrompt, documents]);

  // --- Import a .ivn.json file ---
  const handleImportScript = useCallback(async (file: File) => {
    try {
      const json = await file.text();
      const record = parseImportedScript(json);
      await scriptStorage.save(record);
      await refreshScriptList();
      // Load the imported script
      const docs = manifestToDocuments(record.manifest);
      setDocuments(docs);
      setSelectedDocId(docs.length > 0 ? docs[0]!.id : null);
      setStateSchema(record.manifest.stateSchema);
      setMemoryConfig(record.manifest.memoryConfig);
      setEnabledTools(record.manifest.enabledTools);
      setInitialPrompt(record.manifest.initialPrompt ?? '开始测试');
      setLoadedScriptId(record.id);
      setScriptLabel(record.label);
      setScriptDescription(record.description);
      setScriptVersion(record.manifest.version ?? '0.0.0');
      setScriptTags(record.manifest.tags ?? []);
      setPromptAssemblyOrder(record.manifest.promptAssemblyOrder);
      setShowScriptLibrary(false);
    } catch (err) {
      alert('导入失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  }, [refreshScriptList]);

  // --- Create new empty script ---
  const handleNewScript = useCallback(() => {
    setDocuments([]);
    setSelectedDocId(null);
    setLoadedScriptId(null);
    setScriptLabel('未命名剧本');
    setScriptDescription('');
    setScriptVersion('0.0.0');
    setScriptTags([]);
    setStateSchema(defaultStateSchema);
    setMemoryConfig(defaultMemoryConfig);
    setEnabledTools(['read_state', 'query_changelog', 'pin_memory', 'query_memory', 'set_mood']);
    setInitialPrompt('开始测试');
    setIsPublished(false);
    setPromptAssemblyOrder(undefined);
    setShowScriptLibrary(false);
  }, []);

  // --- Publish / unpublish script ---
  const handlePublishScript = useCallback(async () => {
    if (!loadedScriptId) return;  // must save first
    setPublishing(true);
    try {
      if (getEngineMode() === 'remote') {
        const authHeader = useAuthStore.getState().getAuthHeader();
        // Remote mode: POST full record to backend
        if (isPublished) {
          // Unpublish: delete from backend
          await fetch(`${getBackendUrl()}/api/scripts/${loadedScriptId}`, {
            method: 'DELETE',
            headers: authHeader,
          });
          setIsPublished(false);
        } else {
          // Publish: send record to backend
          const record = await scriptStorage.get(loadedScriptId);
          if (!record) return;
          await fetch(`${getBackendUrl()}/api/scripts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeader },
            body: JSON.stringify({
              id: record.id,
              label: record.label,
              description: record.description,
              createdAt: record.createdAt,
              updatedAt: Date.now(),
              published: true,
              manifest: record.manifest,
            }),
          });
          setIsPublished(true);
        }
      } else {
        // Local mode: toggle in IndexedDB
        if (isPublished) {
          await scriptStorage.unpublish(loadedScriptId);
          setIsPublished(false);
        } else {
          await scriptStorage.publish(loadedScriptId);
          setIsPublished(true);
        }
      }
      await refreshScriptList();
    } finally {
      setPublishing(false);
    }
  }, [loadedScriptId, isPublished, refreshScriptList]);

  // --- Create new empty .md file ---
  const handleNewFile = useCallback(() => {
    const name = prompt('输入文件名（含 .md 后缀）:', '新文件.md');
    if (!name) return;
    const doc: EditorDocument = {
      id: createDocId(),
      filename: name.endsWith('.md') ? name : name + '.md',
      content: '',
      role: 'context',
      priority: 5,
      injectionCondition: '',
      injectionDescription: '',
    };
    setDocuments((prev) => [...prev, doc]);
    setSelectedDocId(doc.id);
  }, []);

  // --- Segments derived from documents ---
  const segments = useMemo(
    () => documents.map(docToSegment),
    [documents],
  );

  // --- State vars for autocomplete (derived from current schema) ---
  const stateVars = useMemo<StateVarInfo[]>(
    () => stateSchema.variables.map((v) => ({ name: v.name, type: v.type, description: v.description })),
    [stateSchema],
  );

  // --- Handlers ---
  const handleFilesUpload = useCallback(async (files: FileList) => {
    const newDocs: EditorDocument[] = [];
    for (const file of Array.from(files)) {
      if (!file.name.endsWith('.md') && !file.name.endsWith('.txt')) continue;
      const content = await file.text();

      // Heuristic role assignment
      const nameLower = file.name.toLowerCase();
      let role: SegmentRole = 'context';
      let priority = 5;
      let injectionCondition = '';
      let injectionDescription = '';

      if (nameLower.includes('gm_prompt') || nameLower.includes('gm prompt')) {
        role = 'system';
        priority = 0;
        // Try to detect chapter-specific condition
        if (nameLower.includes('第一章') || nameLower.includes('序章')) {
          injectionCondition = 'chapter === 1';
          injectionDescription = '第一章 GM 指令';
        } else if (nameLower.includes('第二章')) {
          injectionCondition = 'chapter === 2';
          injectionDescription = '第二章 GM 指令';
        }
      } else if (nameLower.includes('pc_prompt') || nameLower.includes('pc prompt')) {
        role = 'context';
        priority = 1;
        injectionCondition = "mode === 'auto-simulation'";
        injectionDescription = 'PC 模拟器指令（仅自动模拟模式）';
      }

      newDocs.push({
        id: createDocId(),
        filename: file.name,
        content,
        role,
        priority,
        injectionCondition,
        injectionDescription,
      });
    }

    if (newDocs.length > 0) {
      setDocuments((prev) => [...prev, ...newDocs]);
      // Select first new doc if nothing selected
      setSelectedDocId((prev) => prev ?? newDocs[0]!.id);
    }
  }, []);

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFilesUpload(e.target.files);
      e.target.value = ''; // reset for re-upload of same file
    }
  }, [handleFilesUpload]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) {
      handleFilesUpload(e.dataTransfer.files);
    }
  }, [handleFilesUpload]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleContentChange = useCallback((newContent: string) => {
    if (!selectedDocId) return;
    setDocuments((prev) =>
      prev.map((d) => d.id === selectedDocId ? { ...d, content: newContent } : d),
    );
  }, [selectedDocId]);

  const handleDeleteDoc = useCallback((id: string) => {
    setDocuments((prev) => prev.filter((d) => d.id !== id));
    setSelectedDocId((prev) => {
      if (prev !== id) return prev;
      const remaining = documents.filter((d) => d.id !== id);
      return remaining.length > 0 ? remaining[0]!.id : null;
    });
  }, [documents]);

  const handleDocMetaChange = useCallback((
    id: string,
    field: 'role' | 'priority' | 'injectionCondition' | 'injectionDescription' | 'filename',
    value: string | number,
  ) => {
    setDocuments((prev) =>
      prev.map((d) => d.id === id ? { ...d, [field]: value } : d),
    );
  }, []);

  // --- Build manifest for play panel ---
  const playManifest = useMemo<ScriptManifest>(() => {
    const flowGraph: FlowGraph = { id: 'draft-flow', label: '草稿', nodes: [], edges: [] };
    return {
      id: loadedScriptId ?? 'editor-draft',
      version: '0.0.0',
      label: '编辑器试玩',
      stateSchema,
      memoryConfig,
      enabledTools,
      initialPrompt: initialPrompt || undefined,
      promptAssemblyOrder: promptAssemblyOrder,
      chapters: [{
        id: 'draft-ch1',
        label: '草稿章节',
        flowGraph,
        segments,
      }],
    };
  }, [segments, initialPrompt, stateSchema, memoryConfig, enabledTools, loadedScriptId, promptAssemblyOrder]);

  return (
    <div className="h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Header */}
      <header className="flex-none px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={goHome}
            className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            ← 返回
          </button>
          <h1 className="text-sm font-medium text-zinc-300">编剧编辑器</h1>
          {loadedScriptId && (
            <span className="text-xs text-zinc-500">— {scriptLabel}</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <span>{documents.length} 个文件</span>
          <span className="text-zinc-700">|</span>
          <span>~{segments.reduce((sum, s) => sum + s.tokenCount, 0).toLocaleString()} tokens</span>
          <span className="text-zinc-700">|</span>
          <button
            onClick={handlePublishScript}
            disabled={!loadedScriptId || publishing}
            className={cn(
              'px-2.5 py-1 rounded text-[11px] font-medium transition-colors disabled:opacity-40',
              isPublished
                ? 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
                : 'bg-emerald-700 text-white hover:bg-emerald-600',
            )}
            title={!loadedScriptId ? '请先保存剧本' : isPublished ? '取消发布' : '发布到首页'}
          >
            {publishing ? '...' : isPublished ? '已发布' : '发布'}
          </button>
        </div>
      </header>

      {/* Main content */}
      <div
        className="flex-1 flex min-h-0"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        {/* Left: File sidebar + Editor */}
        <div className="flex-1 flex min-w-0">
          {/* File sidebar */}
          <div className="w-56 flex-none border-r border-zinc-800 flex flex-col">
            {/* Script library + actions */}
            <div className="flex-none px-3 py-2 border-b border-zinc-800 space-y-2">
              {/* Current script name */}
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setShowScriptLibrary(!showScriptLibrary)}
                  className="flex-1 text-left text-xs px-2 py-1.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-300 hover:border-zinc-500 transition-colors truncate"
                >
                  {scriptLabel || '选择剧本...'}
                  <span className="text-zinc-600 ml-1">{showScriptLibrary ? '▲' : '▼'}</span>
                </button>
                <button
                  onClick={handleSaveScript}
                  disabled={saving}
                  className="flex-none text-[11px] px-1.5 py-1.5 rounded bg-emerald-800 hover:bg-emerald-700 text-white disabled:opacity-50 transition-colors"
                  title="保存剧本"
                >
                  {saving ? '...' : '保存'}
                </button>
              </div>

              {/* Script library dropdown */}
              {showScriptLibrary && (
                <div className="bg-zinc-900 border border-zinc-700 rounded overflow-hidden">
                  {/* Action buttons */}
                  <div className="flex border-b border-zinc-800">
                    <button
                      onClick={handleNewScript}
                      className="flex-1 text-[10px] py-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors"
                    >
                      新建
                    </button>
                    <button
                      onClick={() => importInputRef.current?.click()}
                      className="flex-1 text-[10px] py-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition-colors border-l border-zinc-800"
                    >
                      导入
                    </button>
                    <button
                      onClick={handleExportScript}
                      disabled={documents.length === 0}
                      className="flex-1 text-[10px] py-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 disabled:opacity-30 transition-colors border-l border-zinc-800"
                    >
                      导出
                    </button>
                  </div>
                  {/* Script list */}
                  <div className="max-h-48 overflow-y-auto">
                    {scriptList.length === 0 ? (
                      <div className="px-2 py-3 text-center text-[10px] text-zinc-600">
                        {getEngineMode() === 'remote' ? '暂无剧本（本地和服务器均无）' : '暂无保存的剧本'}
                      </div>
                    ) : (
                      scriptList.map((item) => (
                        <ScriptListEntry
                          key={item.id}
                          item={item}
                          isActive={item.id === loadedScriptId}
                          onLoad={handleLoadScript}
                          onRename={handleRenameScript}
                          onDelete={handleDeleteScript}
                        />
                      ))
                    )}
                  </div>
                </div>
              )}

              {/* Hidden import input */}
              <input
                ref={importInputRef}
                type="file"
                accept=".json,.ivn.json"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files?.[0]) {
                    handleImportScript(e.target.files[0]);
                    e.target.value = '';
                  }
                }}
              />

              {/* File actions: upload + new file */}
              <div className="flex gap-1">
                <button
                  onClick={handleUploadClick}
                  className="flex-1 text-[11px] px-2 py-1 rounded border border-dashed border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  上传 .md
                </button>
                <button
                  onClick={handleNewFile}
                  className="flex-1 text-[11px] px-2 py-1 rounded border border-dashed border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-300 transition-colors"
                >
                  新建文件
                </button>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".md,.txt"
                multiple
                className="hidden"
                onChange={handleFileInputChange}
              />
            </div>

            {/* File list */}
            <div className="flex-1 min-h-0 overflow-y-auto">
              {documents.length === 0 ? (
                <div className="px-3 py-8 text-center text-xs text-zinc-600">
                  拖拽 .md 文件到此处
                  <br />
                  或点击上方按钮
                </div>
              ) : (
                <div className="py-1">
                  {documents.map((doc) => (
                    <FileListItem
                      key={doc.id}
                      doc={doc}
                      selected={doc.id === selectedDocId}
                      onSelect={() => setSelectedDocId(doc.id)}
                      onDelete={() => handleDeleteDoc(doc.id)}
                      onRename={(name) => handleDocMetaChange(doc.id, 'filename', name)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Initial prompt config */}
            <div className="flex-none px-3 py-2 border-t border-zinc-800 space-y-1">
              <label className="text-[10px] text-zinc-500 uppercase tracking-wider">
                Initial Prompt
              </label>
              <input
                type="text"
                value={initialPrompt}
                onChange={(e) => setInitialPrompt(e.target.value)}
                placeholder="首轮 user message"
                className="w-full text-xs px-2 py-1 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
              />
            </div>
          </div>

          {/* Editor area */}
          <div className="flex-1 min-w-0 flex flex-col">
            {selectedDoc ? (
              <>
                {/* Doc meta bar */}
                <DocMetaBar
                  doc={selectedDoc}
                  onMetaChange={(field, value) => handleDocMetaChange(selectedDoc.id, field, value)}
                />
                {/* Code editor */}
                <div className="flex-1 min-h-0">
                  <CodeEditor
                    value={selectedDoc.content}
                    onChange={handleContentChange}
                    stateVars={stateVars}
                  />
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-zinc-600 text-sm">
                {documents.length === 0
                  ? '上传 Markdown 文件开始编辑'
                  : '选择左侧文件开始编辑'}
              </div>
            )}
          </div>
        </div>

        {/* Right: Tabbed panel */}
        <div className="w-[420px] flex-none flex flex-col min-h-0 bg-zinc-950 border-l border-zinc-800">
          {/* Tab bar */}
          <div className="flex-none flex border-b border-zinc-800">
            {([
              { id: 'prompt' as const, label: 'Prompt 预览', activeClass: 'text-zinc-200 border-b-2 border-zinc-400' },
              { id: 'play' as const, label: '试玩', activeClass: 'text-emerald-400 border-b-2 border-emerald-500' },
              { id: 'debug' as const, label: '调试', activeClass: 'text-amber-400 border-b-2 border-amber-500' },
              { id: 'info' as const, label: '剧本信息', activeClass: 'text-blue-400 border-b-2 border-blue-500' },
              { id: 'settings' as const, label: '设置', activeClass: 'text-zinc-200 border-b-2 border-zinc-400' },
            ]).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setRightTab(tab.id)}
                className={cn(
                  'flex-1 px-3 py-2 text-xs font-medium transition-colors',
                  rightTab === tab.id ? tab.activeClass : 'text-zinc-500 hover:text-zinc-400',
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Tab content — PlayPanel 始终挂载（hidden），避免切 tab 丢失 session */}
          <div className="flex-1 min-h-0 overflow-hidden relative">
            <div className={cn('absolute inset-0', rightTab !== 'prompt' && 'hidden')}>
              <PromptPreviewPanel
                segments={segments}
                stateSchema={stateSchema}
                initialPrompt={initialPrompt}
                assemblyOrder={promptAssemblyOrder}
                onOrderChange={setPromptAssemblyOrder}
              />
            </div>
            <div className={cn('absolute inset-0', rightTab !== 'play' && 'hidden')}>
              <PlayPanel
                manifest={playManifest}
                compact
                showDebug={false}
                showReasoning
                forceLocal
              />
            </div>
            <div className={cn('absolute inset-0', rightTab !== 'debug' && 'hidden')}>
              <EditorDebugPanel />
            </div>
            <div className={cn('absolute inset-0', rightTab !== 'info' && 'hidden')}>
              <ScriptInfoPanel
                label={scriptLabel}
                description={scriptDescription}
                version={scriptVersion}
                tags={scriptTags}
                stateSchema={stateSchema}
                memoryConfig={memoryConfig}
                enabledTools={enabledTools}
                initialPrompt={initialPrompt}
                onLabelChange={setScriptLabel}
                onDescriptionChange={setScriptDescription}
                onVersionChange={setScriptVersion}
                onTagsChange={setScriptTags}
                onStateSchemaChange={setStateSchema}
                onMemoryConfigChange={setMemoryConfig}
                onEnabledToolsChange={setEnabledTools}
                onInitialPromptChange={setInitialPrompt}
              />
            </div>
            <div className={cn('absolute inset-0 overflow-y-auto p-3', rightTab !== 'settings' && 'hidden')}>
              <LLMSettingsPanel />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// FileListItem — 文件列表项
// ============================================================================

function FileListItem({
  doc,
  selected,
  onSelect,
  onDelete,
  onRename,
}: {
  doc: EditorDocument;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
}) {
  const tokenCount = estimateTokens(doc.content);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(doc.filename);

  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditName(doc.filename);
    setEditing(true);
  }, [doc.filename]);

  const handleRenameConfirm = useCallback(() => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== doc.filename) {
      onRename(trimmed.endsWith('.md') ? trimmed : trimmed + '.md');
    }
    setEditing(false);
  }, [editName, doc.filename, onRename]);

  return (
    <div
      onClick={onSelect}
      className={cn(
        'group px-3 py-1.5 cursor-pointer flex items-start gap-2 transition-colors',
        selected ? 'bg-zinc-800/60' : 'hover:bg-zinc-900/50',
      )}
    >
      {/* Role indicator dot */}
      <span className={cn(
        'flex-none mt-1.5 w-2 h-2 rounded-full',
        doc.role === 'system' ? 'bg-purple-500' :
        doc.role === 'draft' ? 'bg-zinc-500' :
        'bg-cyan-500',
      )} />

      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            autoFocus
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleRenameConfirm}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameConfirm();
              if (e.key === 'Escape') setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
            className="w-full text-xs px-1 py-0 bg-zinc-800 border border-zinc-600 rounded text-zinc-200 focus:outline-none"
          />
        ) : (
          <div
            onDoubleClick={handleDoubleClick}
            className={cn(
              'text-xs truncate',
              selected ? 'text-zinc-200' : 'text-zinc-400',
            )}
            title="双击重命名"
          >
            {doc.filename}
          </div>
        )}
        <div className="flex items-center gap-1.5 text-[10px] text-zinc-600">
          <span>{doc.role}</span>
          <span>P{doc.priority}</span>
          <span>~{tokenCount.toLocaleString()} tok</span>
        </div>
        {doc.injectionCondition && (
          <div className="text-[10px] text-amber-700 truncate">
            if: {doc.injectionCondition}
          </div>
        )}
      </div>

      {/* Delete button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="flex-none mt-0.5 text-zinc-700 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all text-xs"
        title="删除"
      >
        ×
      </button>
    </div>
  );
}

// ============================================================================
// DocMetaBar — 文档元信息编辑栏
// ============================================================================

function DocMetaBar({
  doc,
  onMetaChange,
}: {
  doc: EditorDocument;
  onMetaChange: (
    field: 'role' | 'priority' | 'injectionCondition' | 'injectionDescription',
    value: string | number,
  ) => void;
}) {
  const tokenCount = estimateTokens(doc.content);

  return (
    <div className="flex-none px-3 py-2 border-b border-zinc-800 flex items-center gap-3 text-xs flex-wrap">
      {/* Filename */}
      <span className="text-zinc-300 font-medium">{doc.filename}</span>

      <span className="text-zinc-700">|</span>

      {/* Role selector */}
      <label className="flex items-center gap-1 text-zinc-500">
        Role:
        <select
          value={doc.role}
          onChange={(e) => onMetaChange('role', e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-zinc-300 text-xs focus:outline-none"
        >
          <option value="system">system</option>
          <option value="context">context</option>
          <option value="draft">draft</option>
        </select>
      </label>

      {/* Priority */}
      <label className="flex items-center gap-1 text-zinc-500">
        Priority:
        <input
          type="number"
          value={doc.priority}
          onChange={(e) => onMetaChange('priority', parseInt(e.target.value) || 0)}
          className="w-12 bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-zinc-300 text-xs text-center focus:outline-none"
          min={0}
          max={99}
        />
      </label>

      {/* Injection condition */}
      <label className="flex items-center gap-1 text-zinc-500 flex-1 min-w-0">
        Condition:
        <input
          type="text"
          value={doc.injectionCondition}
          onChange={(e) => onMetaChange('injectionCondition', e.target.value)}
          placeholder="空 = 始终注入"
          className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-300 text-xs font-mono placeholder:text-zinc-600 focus:outline-none"
        />
      </label>

      <span className="text-zinc-600">~{tokenCount.toLocaleString()} tok</span>
    </div>
  );
}

// ============================================================================
// ScriptListEntry — 剧本列表条目（支持 inline 重命名）
// ============================================================================

function ScriptListEntry({
  item,
  isActive,
  onLoad,
  onRename,
  onDelete,
}: {
  item: MergedScriptItem;
  isActive: boolean;
  onLoad: (id: string) => void;
  onRename: (id: string, newLabel: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(item.label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commitRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== item.label) {
      onRename(item.id, trimmed);
    } else {
      setEditValue(item.label);
    }
    setEditing(false);
  };

  return (
    <div
      className={cn(
        'px-2 py-1.5 flex items-center gap-1.5 cursor-pointer hover:bg-zinc-800 transition-colors',
        isActive && 'bg-zinc-800/60',
      )}
      onClick={() => !editing && onLoad(item.id)}
    >
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') { setEditValue(item.label); setEditing(false); }
            }}
            onClick={(e) => e.stopPropagation()}
            className="w-full text-xs px-1 py-0.5 bg-zinc-800 border border-zinc-600 rounded text-zinc-200 outline-none"
          />
        ) : (
          <div className="text-xs text-zinc-300 truncate">
            {item.label}
            {item.published && <span className="ml-1 text-[9px] text-emerald-500">已发布</span>}
            {item.source === 'remote' && (
              <span className="ml-1 text-[9px] text-cyan-400">云端</span>
            )}
            {item.source === 'both' && item.newerOnServer && (
              <span className="ml-1 text-[9px] text-amber-400">有更新</span>
            )}
            {item.source === 'both' && !item.newerOnServer && (
              <span className="ml-1 text-[9px] text-zinc-500">已同步</span>
            )}
          </div>
        )}
        <div className="text-[10px] text-zinc-600">
          {item.source === 'remote' ? `${item.fileCount} 章` : `${item.fileCount} 文件`}
          {item.version && <span className="ml-1">v{item.version}</span>}
          {item.source !== 'remote' && <span> · {new Date(item.updatedAt).toLocaleDateString()}</span>}
        </div>
      </div>
      {item.source !== 'remote' && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setEditValue(item.label);
            setEditing(true);
          }}
          className="flex-none text-zinc-600 hover:text-zinc-300 transition-colors text-[10px]"
          title="重命名"
        >
          ✎
        </button>
      )}
      {item.source !== 'remote' && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(`确认删除「${item.label}」？`)) {
              onDelete(item.id);
            }
          }}
          className="flex-none text-zinc-600 hover:text-red-400 transition-colors text-xs"
          title="删除"
        >
          ×
        </button>
      )}
    </div>
  );
}
