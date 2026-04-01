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

import { useState, useCallback, useMemo, useRef } from 'react';
import { useAppStore } from '../../stores/app-store';
import { CodeEditor } from './CodeEditor';
import { EditorDebugPanel } from './EditorDebugPanel';
import { PromptPreviewPanel } from './PromptPreviewPanel';
import { PlayPanel } from '../play/PlayPanel';
import { estimateTokens } from '../../core/memory';
import { getCatalog, getManifestById } from '../../fixtures/registry';
import { cn } from '../../lib/utils';
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
// Default state schema (MODULE_7 aligned)
// ============================================================================

const defaultStateSchema: StateSchema = {
  variables: [
    { name: 'chapter', type: 'number', initial: 1, description: '当前章节' },
    { name: 'stage', type: 'number', initial: 1, description: '当前阶段序号' },
    { name: 'route', type: 'string', initial: 'main', description: '路线状态' },
    { name: 'player_type', type: 'string', initial: 'unknown', description: '分流类型' },
    { name: 'player_knowledge', type: 'string', initial: 'unknown', description: '知识背景' },
    { name: 'girl_language_level', type: 'number', initial: 0, description: '女孩语言状态' },
    { name: 'player_tendency', type: 'string', initial: 'unknown', description: '行为倾向' },
    { name: 'player_preference', type: 'string', initial: 'unknown', description: '偏好类型' },
    { name: 'deviation_count', type: 'number', initial: 0, description: '连续偏离次数' },
    { name: 'current_location', type: 'string', initial: 'wasteland', description: '当前位置' },
  ],
};

const defaultMemoryConfig: MemoryConfig = {
  contextBudget: 200000,
  compressionThreshold: 160000,
  recencyWindow: 10,
};

// ============================================================================
// Right panel tab type
// ============================================================================

type RightTab = 'prompt' | 'play' | 'debug';

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
  const fileInputRef = useRef<HTMLInputElement>(null);

  const selectedDoc = documents.find((d) => d.id === selectedDocId) ?? null;

  // --- Available scripts from registry ---
  const catalog = useMemo(() => getCatalog(), []);

  // --- Load a built-in script ---
  const handleLoadScript = useCallback((scriptId: string) => {
    const manifest = getManifestById(scriptId);
    if (!manifest) return;

    const docs = manifestToDocuments(manifest);
    setDocuments(docs);
    setSelectedDocId(docs.length > 0 ? docs[0]!.id : null);
    setStateSchema(manifest.stateSchema);
    setMemoryConfig(manifest.memoryConfig);
    setEnabledTools(manifest.enabledTools);
    setInitialPrompt(manifest.initialPrompt ?? '开始测试');
    setLoadedScriptId(scriptId);
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
    field: 'role' | 'priority' | 'injectionCondition' | 'injectionDescription',
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
      chapters: [{
        id: 'draft-ch1',
        label: '草稿章节',
        flowGraph,
        segments,
      }],
    };
  }, [segments, initialPrompt, stateSchema, memoryConfig, enabledTools, loadedScriptId]);

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
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-500">
          <span>{documents.length} 个文件</span>
          <span className="text-zinc-700">|</span>
          <span>~{segments.reduce((sum, s) => sum + s.tokenCount, 0).toLocaleString()} tokens</span>
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
            {/* Script selector + Upload */}
            <div className="flex-none px-3 py-2 border-b border-zinc-800 space-y-2">
              {/* Load built-in script */}
              <select
                value={loadedScriptId ?? ''}
                onChange={(e) => {
                  if (e.target.value) handleLoadScript(e.target.value);
                }}
                className="w-full text-xs px-2 py-1.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-300 focus:outline-none focus:border-zinc-500"
              >
                <option value="">选择内置剧本...</option>
                {catalog.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
              {/* Upload files */}
              <button
                onClick={handleUploadClick}
                className="w-full text-xs px-2 py-1.5 rounded border border-dashed border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-300 transition-colors"
              >
                + 上传 .md 文件
              </button>
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
                  或点击上方按钮上传
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

          {/* Tab content */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {rightTab === 'prompt' && (
              <PromptPreviewPanel
                segments={segments}
                stateSchema={stateSchema}
                initialPrompt={initialPrompt}
              />
            )}
            {rightTab === 'play' && (
              <PlayPanel
                manifest={playManifest}
                compact
                showDebug={false}
                showReasoning
              />
            )}
            {rightTab === 'debug' && (
              <EditorDebugPanel />
            )}
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
}: {
  doc: EditorDocument;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const tokenCount = estimateTokens(doc.content);

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
        doc.role === 'system' ? 'bg-purple-500' : 'bg-cyan-500',
      )} />

      <div className="flex-1 min-w-0">
        <div className={cn(
          'text-xs truncate',
          selected ? 'text-zinc-200' : 'text-zinc-400',
        )}>
          {doc.filename}
        </div>
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
