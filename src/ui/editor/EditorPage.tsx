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
import { DiffEditor } from './DiffEditor';
import { EditorDebugPanel } from './EditorDebugPanel';
import { PromptPreviewPanel } from './PromptPreviewPanel';
import { PlayPanel } from '../play/PlayPanel';
import { LLMSettingsPanel } from '../settings/LLMSettingsPanel';
import { ScriptInfoPanel } from './ScriptInfoPanel';
import { VersionHistoryList, type VersionSummary } from './VersionHistoryList';
import { estimateTokens } from '../../core/memory';
import { exportScript, parseImportedScript } from '../../core/script-archive';
import type { ScriptRecord } from '../../core/script-archive';
import { getBackendUrl } from '../../core/engine-mode';
import { useAuthStore } from '../../stores/auth-store';
import { useLLMConfigsStore, entryToLLMConfig } from '../../stores/llm-configs-store';
import { LocalBackupGate } from './LocalBackupGate';

/** 编辑器端"试玩使用 LLM" dropdown 的 localStorage key */
const LS_PLAYTEST_LLM_KEY = 'ivn-editor-playtest-llm-config-id';
import { cn } from '../../lib/utils';
import { LLMClient } from '../../core/llm-client';
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
  derivedContent?: string;      // LLM 改写的衍生版本
  useDerived?: boolean;         // 组装时使用衍生版本
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
    derivedContent: doc.derivedContent,
    useDerived: doc.useDerived,
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
        derivedContent: seg.derivedContent,
        useDerived: seg.useDerived,
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
// Defaults
// ============================================================================

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
// Script list item
// ============================================================================
//
// 6.6 后剧本完全来自后端 `/api/scripts/mine`，不再合并本地 IndexedDB。
// UI 里直接用这个扁平结构。
interface ScriptListItem {
  id: string;
  label: string;
  description: string;
  updatedAt: number;
  fileCount: number;
  published?: boolean;
  tags?: string[];
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
  const [scriptTags, setScriptTags] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // --- Script library state ---
  const [scriptList, setScriptList] = useState<ScriptListItem[]>([]);
  const [showScriptLibrary, setShowScriptLibrary] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [isPublished, setIsPublished] = useState(false);
  const [promptAssemblyOrder, setPromptAssemblyOrder] = useState<string[] | undefined>(undefined);
  const [disabledAssemblySections, setDisabledAssemblySections] = useState<string[]>([]);

  // --- v2.6 version management state ---
  /** 当前编辑的 version id（6.3：只在 remote 模式下有意义） */
  const [loadedVersionId, setLoadedVersionId] = useState<string | null>(null);
  /** 版本列表（当前加载剧本的所有 version，按 versionNumber 降序） */
  const [versionList, setVersionList] = useState<VersionSummary[]>([]);
  const [versionListLoading, setVersionListLoading] = useState(false);
  /** 正在发布的 versionId（用于禁用按钮） */
  const [publishingVersionId, setPublishingVersionId] = useState<string | null>(null);

  // --- v2.7 LLM config state ---
  /** 剧本绑定的 production LLM config id（null = 未设置，走 fallback 链） */
  const [productionLlmConfigId, setProductionLlmConfigId] = useState<string | null>(null);
  /**
   * 编辑器"试玩使用 LLM" dropdown 选择，localStorage 持久化。
   * 也被 AI 改写功能复用（v2.7e）。
   */
  const [playtestLlmConfigId, setPlaytestLlmConfigIdState] = useState<string | null>(
    () => {
      try {
        return localStorage.getItem(LS_PLAYTEST_LLM_KEY);
      } catch {
        return null;
      }
    },
  );
  const setPlaytestLlmConfigId = useCallback((id: string | null) => {
    try {
      if (id) localStorage.setItem(LS_PLAYTEST_LLM_KEY, id);
      else localStorage.removeItem(LS_PLAYTEST_LLM_KEY);
    } catch {
      // ignore
    }
    setPlaytestLlmConfigIdState(id);
  }, []);

  // 拉取 llm_configs 列表（admin 登录后才能用）
  const llmConfigs = useLLMConfigsStore((s) => s.configs);
  const llmConfigsLoaded = useLLMConfigsStore((s) => s.loaded);
  const refreshLlmConfigs = useLLMConfigsStore((s) => s.refresh);
  useEffect(() => {
    if (!llmConfigsLoaded) refreshLlmConfigs().catch(() => {});
  }, [llmConfigsLoaded, refreshLlmConfigs]);

  const selectedDoc = documents.find((d) => d.id === selectedDocId) ?? null;

  // --- Load script list from GET /api/scripts/mine ---
  //
  // 6.6 后完全从后端读取（IndexedDB 已下线）。编辑器展示的是"我的所有
  // 剧本"——当前全管理员共用同一份 visible set，包含未发布 draft。
  const refreshScriptList = useCallback(async () => {
    try {
      const authHeader = useAuthStore.getState().getAuthHeader();
      const res = await fetch(`${getBackendUrl()}/api/scripts/mine`, { headers: authHeader });
      if (!res.ok) {
        setScriptList([]);
        return;
      }
      const { scripts: mineScripts } = (await res.json()) as {
        scripts: Array<{
          id: string;
          label: string;
          description: string | null;
          createdAt: string;
          updatedAt: string;
          versionCount: number;
          hasPublished: boolean;
          publishedVersionId: string | null;
          latestDraftVersionId: string | null;
        }>;
      };
      setScriptList(
        mineScripts.map((s) => ({
          id: s.id,
          label: s.label,
          description: s.description ?? '',
          updatedAt: new Date(s.updatedAt).getTime(),
          fileCount: 0,
          published: s.hasPublished,
        })),
      );
    } catch (err) {
      console.error('[refreshScriptList] failed:', err);
      setScriptList([]);
    }
  }, []);

  // --- v2.6: 拉当前剧本的 version list ---
  const refreshVersionList = useCallback(async (scriptId: string | null) => {
    if (!scriptId) {
      setVersionList([]);
      return;
    }
    setVersionListLoading(true);
    try {
      const authHeader = useAuthStore.getState().getAuthHeader();
      const res = await fetch(
        `${getBackendUrl()}/api/scripts/${scriptId}/versions`,
        { headers: authHeader },
      );
      if (res.ok) {
        const { versions } = (await res.json()) as { versions: VersionSummary[] };
        setVersionList(versions);
      } else {
        setVersionList([]);
      }
    } catch {
      setVersionList([]);
    } finally {
      setVersionListLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshScriptList();
  }, [refreshScriptList]);

  // --- applyManifest: helper to flush a ScriptRecord-like object to editor state ---
  const applyRecordToEditor = useCallback((record: {
    id: string;
    label: string;
    description: string;
    published?: boolean;
    manifest: ScriptManifest;
    productionLlmConfigId?: string | null;
  }) => {
    const manifest = record.manifest;
    const docs = manifestToDocuments(manifest);
    setDocuments(docs);
    setSelectedDocId(docs.length > 0 ? docs[0]!.id : null);
    setStateSchema(manifest.stateSchema);
    setMemoryConfig(manifest.memoryConfig);
    setEnabledTools(manifest.enabledTools);
    setInitialPrompt(manifest.initialPrompt ?? '开始测试');
    setLoadedScriptId(record.id);
    setScriptLabel(record.label);
    setScriptDescription(record.description);
    setScriptTags(manifest.tags ?? []);
    setIsPublished(!!record.published);
    setPromptAssemblyOrder(manifest.promptAssemblyOrder);
    setDisabledAssemblySections(manifest.disabledAssemblySections ?? []);
    setProductionLlmConfigId(record.productionLlmConfigId ?? null);
    setShowScriptLibrary(false);
  }, []);

  // --- Load a script (version-aware) ---
  //
  // 流程：
  //   1. GET /api/scripts/:id/versions → 拿到版本列表
  //   2. 选"最新 draft 优先，否则最新 published"
  //   3. GET /api/script-versions/:versionId → 拿 manifest
  //   4. GET /api/scripts/:id/full → 拿 label/description
  //   5. flush 到 editor
  const handleLoadScript = useCallback(async (scriptId: string) => {
    try {
      const authHeader = useAuthStore.getState().getAuthHeader();
      const vres = await fetch(
        `${getBackendUrl()}/api/scripts/${scriptId}/versions`,
        { headers: authHeader },
      );
      if (!vres.ok) {
        alert(`加载剧本失败 (${vres.status})`);
        return;
      }
      const { versions } = (await vres.json()) as { versions: VersionSummary[] };
      const pick =
        versions.find((v) => v.status === 'draft') ??
        versions.find((v) => v.status === 'published') ??
        versions[0];
      if (!pick) {
        alert('该剧本还没有任何版本');
        return;
      }
      const dres = await fetch(
        `${getBackendUrl()}/api/script-versions/${pick.id}`,
        { headers: authHeader },
      );
      if (!dres.ok) {
        alert(`加载版本失败 (${dres.status})`);
        return;
      }
      const version = (await dres.json()) as {
        id: string;
        scriptId: string;
        status: string;
        manifest: ScriptManifest;
        label: string | null;
      };
      const sres = await fetch(
        `${getBackendUrl()}/api/scripts/${scriptId}/full`,
        { headers: authHeader },
      );
      const scriptMeta = sres.ok
        ? ((await sres.json()) as {
            id: string;
            label: string;
            description: string;
            published: boolean;
            productionLlmConfigId?: string | null;
          })
        : {
            id: scriptId,
            label: version.manifest.label,
            description: '',
            published: false,
            productionLlmConfigId: null,
          };

      applyRecordToEditor({
        id: scriptMeta.id,
        label: scriptMeta.label,
        description: scriptMeta.description,
        published: scriptMeta.published,
        manifest: version.manifest,
        productionLlmConfigId: scriptMeta.productionLlmConfigId ?? null,
      });
      setLoadedVersionId(version.id);
      await refreshVersionList(scriptId);
    } catch (err) {
      console.error('[handleLoadScript] failed:', err);
      alert(`加载失败: ${err}`);
    }
  }, [applyRecordToEditor, refreshVersionList]);

  // --- Save current editor state ---
  //
  // 流程：
  //   1. 如果没有 loadedScriptId → POST /api/scripts 新建 → 拿后端分配的 UUID
  //   2. 如果有 loadedScriptId → PATCH /api/scripts/:id 同步元数据
  //      （404 视为错误；6.6 后前端不再持有孤儿 id，理论上不会触发）
  //   3. POST /api/scripts/:id/versions 创建 draft 版本（后端按 content hash 去重）
  const handleSaveScript = useCallback(async () => {
    setSaving(true);
    try {
      const flowGraph: FlowGraph = { id: 'draft-flow', label: '草稿', nodes: [], edges: [] };
      const authHeader = useAuthStore.getState().getAuthHeader();
      let scriptId = loadedScriptId;

      // Step 1: 新建或同步元数据
      if (scriptId) {
        const patchRes = await fetch(`${getBackendUrl()}/api/scripts/${scriptId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({
            label: scriptLabel,
            description: scriptDescription,
            productionLlmConfigId,
          }),
        });
        if (!patchRes.ok) {
          alert(`保存失败 (PATCH ${patchRes.status})`);
          return;
        }
      } else {
        const createRes = await fetch(`${getBackendUrl()}/api/scripts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({
            label: scriptLabel,
            description: scriptDescription,
            productionLlmConfigId,
          }),
        });
        if (!createRes.ok) {
          alert(`创建剧本失败 (${createRes.status})`);
          return;
        }
        const { id: newId } = (await createRes.json()) as { id: string };
        scriptId = newId;
        setLoadedScriptId(newId);
      }

      const id = scriptId!;
      const manifest: ScriptManifest = {
        id,
        label: scriptLabel,
        description: scriptDescription,
        tags: scriptTags.length > 0 ? scriptTags : undefined,
        stateSchema,
        memoryConfig,
        enabledTools,
        initialPrompt: initialPrompt || undefined,
        promptAssemblyOrder: promptAssemblyOrder,
        disabledAssemblySections: disabledAssemblySections.length > 0 ? disabledAssemblySections : undefined,
        chapters: [{
          id: 'ch1',
          label: '第一章',
          flowGraph,
          segments: documents.map(docToSegment),
        }],
      };

      // Step 2: POST 新版本
      const vres = await fetch(`${getBackendUrl()}/api/scripts/${id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ manifest }),
      });
      if (!vres.ok) {
        alert(`保存版本失败 (${vres.status})`);
        return;
      }
      const { versionId, created } = (await vres.json()) as {
        versionId: string;
        created: boolean;
      };
      setLoadedVersionId(versionId);
      await refreshVersionList(id);
      if (!created) {
        console.log('[save] 内容未变化，复用现有版本', versionId);
      }

      setLoadedScriptId(id);
      await refreshScriptList();
    } finally {
      setSaving(false);
    }
  }, [loadedScriptId, scriptLabel, scriptDescription, scriptTags, stateSchema, memoryConfig, enabledTools, initialPrompt, documents, promptAssemblyOrder, disabledAssemblySections, productionLlmConfigId, refreshScriptList, refreshVersionList]);

  // --- Delete a script ---
  // DELETE /api/scripts/:id（级联删 versions + playthroughs）
  const handleDeleteScript = useCallback(async (id: string) => {
    try {
      const authHeader = useAuthStore.getState().getAuthHeader();
      const res = await fetch(`${getBackendUrl()}/api/scripts/${id}`, {
        method: 'DELETE',
        headers: authHeader,
      });
      if (!res.ok && res.status !== 404) {
        alert(`删除失败 (${res.status})`);
        return;
      }
    } catch (err) {
      console.error('[delete] 失败:', err);
      alert(`删除失败: ${err}`);
      return;
    }
    if (loadedScriptId === id) {
      setLoadedScriptId(null);
      setLoadedVersionId(null);
      setVersionList([]);
      setDocuments([]);
      setSelectedDocId(null);
      setScriptLabel('未命名剧本');
      setScriptDescription('');
    }
    await refreshScriptList();
  }, [loadedScriptId, refreshScriptList]);

  // --- Rename a saved script ---
  // PATCH /api/scripts/:id
  const handleRenameScript = useCallback(async (id: string, newLabel: string) => {
    try {
      const authHeader = useAuthStore.getState().getAuthHeader();
      const res = await fetch(`${getBackendUrl()}/api/scripts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ label: newLabel }),
      });
      if (!res.ok) {
        alert(`重命名失败 (${res.status})`);
        return;
      }
    } catch (err) {
      console.error('[rename] 失败:', err);
      alert(`重命名失败: ${err}`);
      return;
    }
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
  //
  // 6.6 后直接上传到后端：POST /api/scripts 新建 + POST /api/scripts/:id/versions
  // 创建 draft 版本。导入文件里的原始 id 不复用（后端重新分配 UUID），避免
  // 和已有剧本 id 冲突。
  const handleImportScript = useCallback(async (file: File) => {
    try {
      const json = await file.text();
      const record = parseImportedScript(json);
      const authHeader = useAuthStore.getState().getAuthHeader();

      // Step 1: 新建 script 行
      const createRes = await fetch(`${getBackendUrl()}/api/scripts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          label: record.label,
          description: record.description,
        }),
      });
      if (!createRes.ok) {
        alert(`导入失败 (创建剧本 ${createRes.status})`);
        return;
      }
      const { id: newId } = (await createRes.json()) as { id: string };

      // Step 2: 用新 id 重写 manifest.id 后上传为首个版本
      const manifest: ScriptManifest = { ...record.manifest, id: newId };
      const vres = await fetch(`${getBackendUrl()}/api/scripts/${newId}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({ manifest }),
      });
      if (!vres.ok) {
        alert(`导入失败 (创建版本 ${vres.status})`);
        return;
      }

      // Step 3: 刷新列表 + 加载到编辑器
      await refreshScriptList();
      await handleLoadScript(newId);
      setShowScriptLibrary(false);
    } catch (err) {
      alert('导入失败: ' + (err instanceof Error ? err.message : String(err)));
    }
  }, [refreshScriptList, handleLoadScript]);

  // --- Create new empty script ---
  //
  // 不立即调后端——只 reset 本地 state。第一次点"保存"时才会 POST
  // /api/scripts 在后端建 script 行（走 handleSaveScript 里的新建分支）。
  const handleNewScript = useCallback(() => {
    setDocuments([]);
    setSelectedDocId(null);
    setLoadedScriptId(null);
    setLoadedVersionId(null);
    setVersionList([]);
    setScriptLabel('未命名剧本');
    setScriptDescription('');
    setScriptTags([]);
    setStateSchema(defaultStateSchema);
    setMemoryConfig(defaultMemoryConfig);
    setEnabledTools(['read_state', 'query_changelog', 'pin_memory', 'query_memory', 'set_mood']);
    setInitialPrompt('开始测试');
    setIsPublished(false);
    setPromptAssemblyOrder(undefined);
    setDisabledAssemblySections([]);
    setProductionLlmConfigId(null);
    setShowScriptLibrary(false);
  }, []);

  // --- Publish an arbitrary draft version（供版本历史列用）---
  //
  // POST /api/script-versions/:id/publish
  //   - 该 draft 变 published
  //   - 原 published 自动变 archived
  const handlePublishVersion = useCallback(async (versionId: string) => {
    setPublishingVersionId(versionId);
    try {
      const authHeader = useAuthStore.getState().getAuthHeader();
      const res = await fetch(
        `${getBackendUrl()}/api/script-versions/${versionId}/publish`,
        { method: 'POST', headers: authHeader },
      );
      if (!res.ok) {
        const err = await res.text();
        alert(`发布失败: ${err}`);
        return;
      }
      if (loadedScriptId) {
        await refreshVersionList(loadedScriptId);
      }
      setIsPublished(true);
      await refreshScriptList();
    } finally {
      setPublishingVersionId(null);
    }
  }, [loadedScriptId, refreshVersionList, refreshScriptList]);

  // --- Publish button in header ---
  //
  // 点发布 = 发布当前 loadedVersionId（如果是 draft）。
  // 已经发布时 按钮显示"已发布"，没有 unpublish 操作（过渡期；后续
  // 可以加 "创建新 draft 取代" 的语义）。
  const handlePublishScript = useCallback(async () => {
    if (!loadedScriptId) return;  // must save first
    if (!loadedVersionId) {
      alert('请先保存剧本（创建一个 draft 版本）再发布');
      return;
    }
    setPublishing(true);
    try {
      await handlePublishVersion(loadedVersionId);
    } finally {
      setPublishing(false);
    }
  }, [loadedScriptId, loadedVersionId, handlePublishVersion]);

  // --- 版本列表点击：切换到那个 version ---
  const handleSelectVersion = useCallback(async (versionId: string) => {
    if (!loadedScriptId) return;
    try {
      const authHeader = useAuthStore.getState().getAuthHeader();
      const res = await fetch(
        `${getBackendUrl()}/api/script-versions/${versionId}`,
        { headers: authHeader },
      );
      if (res.ok) {
        const version = (await res.json()) as {
          id: string;
          manifest: ScriptManifest;
          status: string;
        };
        applyRecordToEditor({
          id: loadedScriptId,
          label: scriptLabel,
          description: scriptDescription,
          published: version.status === 'published',
          manifest: version.manifest,
        });
        setLoadedVersionId(version.id);
      }
    } catch (err) {
      console.error('[selectVersion] 失败:', err);
    }
  }, [loadedScriptId, scriptLabel, scriptDescription, applyRecordToEditor]);

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
    field: 'role' | 'priority' | 'injectionCondition' | 'injectionDescription' | 'filename' | 'useDerived',
    value: string | number | boolean,
  ) => {
    setDocuments((prev) =>
      prev.map((d) => d.id === id ? { ...d, [field]: value } : d),
    );
  }, []);

  // --- AI Rewrite for system segments ---
  const [rewritingDocId, setRewritingDocId] = useState<string | null>(null);
  /**
   * v2.7：续写进度显示。null = 不在续写中。
   * 每次进循环更新 segment，UI 显示"续写中 N / maxSegments"。
   */
  const [rewriteProgress, setRewriteProgress] = useState<
    { segment: number; maxSegments: number } | null
  >(null);

  const handleAIRewrite = useCallback(async (docId: string) => {
    const doc = documents.find((d) => d.id === docId);
    if (!doc || doc.role !== 'system') return;

    // v2.7e：从 LLM configs store 取配置。优先用"试玩使用 LLM" dropdown 的
    // 选择，没选就 fallback 到列表里第一个。
    const configsState = useLLMConfigsStore.getState();
    const preferredId = playtestLlmConfigId ?? configsState.configs[0]?.id ?? null;
    const configEntry = configsState.getById(preferredId);
    if (!configEntry) {
      alert('请先在"设置"里创建至少一套 LLM 配置，或在"试玩使用 LLM"里选一套');
      return;
    }
    const llmConfig = entryToLLMConfig(configEntry);
    const client = new LLMClient(llmConfig);

    const rewritePrompt = `你是一位互动叙事引擎的 prompt 优化专家。你的任务是改写下面的 system prompt，使其更好地利用引擎提供的工具系统。

## 引擎提供的工具

1. **update_state(patch)** — 更新游戏状态变量（如：好感度、章节进度、物品库存等）
2. **signal_input_needed(prompt_hint, choices)** — 在叙事到达分支点时，向玩家提供 2-4 个可点击的选项按钮
3. **read_state(keys?)** — 读取当前状态变量
4. **query_changelog(filter)** — 查询状态变更历史
5. **pin_memory(content, tags?)** — 固定重要记忆（防止被压缩丢失）
6. **query_memory(query)** — 搜索历史记忆

## 改写要求

1. **不要改变原文的叙事风格、世界观设定和角色描述**
2. **在适当位置添加工具调用指引**，例如：
   - 在描述需要玩家做选择的情节时，提示使用 signal_input_needed
   - 在描述会影响数值/状态的情节时，提示使用 update_state
   - 在描述重要信息揭示时，提示使用 pin_memory
3. **直接写工具的裸名**（例如 read_state、update_state、signal_input_needed），
   不要加任何特殊符号或占位符。GM 会从 tool schema 识别这些名称。
4. **保持原文结构和段落划分**
5. **输出完整改写后的 prompt，不要输出解释或说明**

## 原始 Prompt

${doc.content}

## 改写后的 Prompt（直接输出，不要加任何前缀说明）`;

    // v2.7：分段续写循环。
    //
    // 如果模型单次 maxOutputTokens 能容纳完整改写，就只转一圈正常返回；
    // 否则 finishReason='length' 时带上"已输出内容"作为 assistant
    // message，让 LLM 从截断处接着往下写。UI 同步显示"续写中 N/M"。
    //
    // 每段 append 到 derivedContent，用户在改写过程中能实时看到进度。
    const MAX_REWRITE_SEGMENTS = 8;

    setRewritingDocId(docId);
    setRewriteProgress({ segment: 0, maxSegments: MAX_REWRITE_SEGMENTS });

    let accumulated = '';
    let reachedLimit = false;

    try {
      for (let seg = 1; seg <= MAX_REWRITE_SEGMENTS; seg++) {
        setRewriteProgress({ segment: seg, maxSegments: MAX_REWRITE_SEGMENTS });

        const messages =
          seg === 1
            ? [{ role: 'user' as const, content: rewritePrompt }]
            : [
                { role: 'user' as const, content: rewritePrompt },
                { role: 'assistant' as const, content: accumulated },
                {
                  role: 'user' as const,
                  content:
                    '继续输出改写后 prompt 的剩余部分。直接从你上次停下的地方续写，不要重复已经输出过的内容，不要加任何前缀说明。',
                },
              ];

        const result = await client.generate({
          systemPrompt:
            '你是 prompt 改写助手。只输出改写后的 prompt 全文，不要输出任何额外说明。',
          messages,
          tools: {},
          maxOutputTokens: 8192,
        });

        if (!result.text) {
          // 模型没返回任何新内容 —— 可能是 provider 抽风，中断避免死循环
          break;
        }

        accumulated += result.text;

        // 实时 append 到 UI：用户可以在续写过程中读到已有内容
        setDocuments((prev) =>
          prev.map((d) =>
            d.id === docId
              ? { ...d, derivedContent: accumulated, useDerived: false }
              : d,
          ),
        );

        if (result.finishReason !== 'length') break;
        if (seg === MAX_REWRITE_SEGMENTS) reachedLimit = true;
      }

      if (reachedLimit) {
        alert(
          `AI 改写续写达到上限 ${MAX_REWRITE_SEGMENTS} 段仍未完成。\n` +
          '已保存累积结果，但内容可能仍被截断。建议手动补齐或拆分原文后重试。',
        );
      }
    } catch (err) {
      alert('AI 改写失败: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setRewritingDocId(null);
      setRewriteProgress(null);
    }
  }, [documents, playtestLlmConfigId]);

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
      disabledAssemblySections: disabledAssemblySections.length > 0 ? disabledAssemblySections : undefined,
      chapters: [{
        id: 'draft-ch1',
        label: '草稿章节',
        flowGraph,
        segments,
      }],
    };
  }, [segments, initialPrompt, stateSchema, memoryConfig, enabledTools, loadedScriptId, promptAssemblyOrder, disabledAssemblySections]);

  return (
    <LocalBackupGate>
      <div className="h-full bg-zinc-950 text-zinc-100 flex flex-col">
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
                        暂无剧本
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

          {/* Version history column (v2.6 / 6.3) */}
          <VersionHistoryList
            currentVersionId={loadedVersionId}
            hasScript={!!loadedScriptId}
            versions={versionList}
            loading={versionListLoading}
            onSelect={handleSelectVersion}
            onPublish={handlePublishVersion}
            publishingVersionId={publishingVersionId}
          />

          {/* Editor area */}
          <div className="flex-1 min-w-0 flex flex-col">
            {selectedDoc ? (
              <>
                {/* Doc meta bar */}
                <DocMetaBar
                  doc={selectedDoc}
                  onMetaChange={(field, value) => handleDocMetaChange(selectedDoc.id, field, value)}
                  onRewrite={() => handleAIRewrite(selectedDoc.id)}
                  rewriting={rewritingDocId === selectedDoc.id}
                  rewriteProgress={
                    rewritingDocId === selectedDoc.id ? rewriteProgress : null
                  }
                />
                {/* Code editor + derived diff */}
                <div className="flex-1 min-h-0 flex">
                  <div className={cn('min-h-0', selectedDoc.derivedContent ? 'flex-1' : 'w-full')}>
                    <CodeEditor
                      value={selectedDoc.content}
                      onChange={handleContentChange}
                      stateVars={stateVars}
                    />
                  </div>
                  {selectedDoc.derivedContent && (
                    <div className="flex-1 min-h-0 border-l border-zinc-800 flex flex-col">
                      <div className="flex-none px-3 py-1.5 border-b border-zinc-800 flex items-center justify-between">
                        <span className="text-[10px] text-violet-400 font-medium">
                          原文 vs AI 衍生版
                        </span>
                        <button
                          onClick={() => setDocuments((prev) =>
                            prev.map((d) => d.id === selectedDoc.id
                              ? { ...d, derivedContent: undefined, useDerived: false }
                              : d,
                            ),
                          )}
                          className="text-[10px] text-zinc-600 hover:text-red-400 transition-colors"
                        >
                          删除衍生
                        </button>
                      </div>
                      <DiffEditor
                        original={selectedDoc.content}
                        modified={selectedDoc.derivedContent}
                        className="flex-1 min-h-0"
                      />
                    </div>
                  )}
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
                disabledSections={disabledAssemblySections}
                onDisabledChange={setDisabledAssemblySections}
              />
            </div>
            <div className={cn('absolute inset-0 flex flex-col', rightTab !== 'play' && 'hidden')}>
              {/* v2.7 试玩使用 LLM 下拉（admin 个人偏好，localStorage 持久化） */}
              <div className="flex-none flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800 bg-zinc-950/60">
                <span className="text-[10px] text-zinc-500">试玩使用：</span>
                <select
                  value={playtestLlmConfigId ?? ''}
                  onChange={(e) => setPlaytestLlmConfigId(e.target.value || null)}
                  className="flex-1 text-[11px] px-2 py-0.5 bg-zinc-900 border border-zinc-700 rounded text-zinc-300 focus:outline-none focus:border-zinc-500"
                >
                  <option value="">（剧本默认 / fallback）</option>
                  {llmConfigs.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex-1 min-h-0">
                <PlayPanel
                  manifest={playManifest}
                  compact
                  showDebug={false}
                  showReasoning
                  editorMode
                  scriptVersionId={loadedVersionId ?? undefined}
                  llmConfigId={playtestLlmConfigId}
                />
              </div>
            </div>
            <div className={cn('absolute inset-0', rightTab !== 'debug' && 'hidden')}>
              <EditorDebugPanel />
            </div>
            <div className={cn('absolute inset-0', rightTab !== 'info' && 'hidden')}>
              <ScriptInfoPanel
                label={scriptLabel}
                description={scriptDescription}
                tags={scriptTags}
                stateSchema={stateSchema}
                memoryConfig={memoryConfig}
                enabledTools={enabledTools}
                initialPrompt={initialPrompt}
                productionLlmConfigId={productionLlmConfigId}
                onLabelChange={setScriptLabel}
                onDescriptionChange={setScriptDescription}
                onTagsChange={setScriptTags}
                onStateSchemaChange={setStateSchema}
                onMemoryConfigChange={setMemoryConfig}
                onEnabledToolsChange={setEnabledTools}
                onInitialPromptChange={setInitialPrompt}
                onProductionLlmConfigIdChange={setProductionLlmConfigId}
              />
            </div>
            <div className={cn('absolute inset-0 overflow-y-auto p-3', rightTab !== 'settings' && 'hidden')}>
              <LLMSettingsPanel />
            </div>
          </div>
        </div>
      </div>
      </div>
    </LocalBackupGate>
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
  onRewrite,
  rewriting,
  rewriteProgress,
}: {
  doc: EditorDocument;
  onMetaChange: (
    field: 'role' | 'priority' | 'injectionCondition' | 'injectionDescription' | 'useDerived',
    value: string | number | boolean,
  ) => void;
  onRewrite?: () => void;
  rewriting?: boolean;
  /** v2.7：续写进度 */
  rewriteProgress?: { segment: number; maxSegments: number } | null;
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

      {/* AI Rewrite button (system segments only) */}
      {doc.role === 'system' && onRewrite && (
        <>
          <span className="text-zinc-700">|</span>
          <button
            onClick={onRewrite}
            disabled={rewriting}
            className={cn(
              'px-2 py-0.5 rounded border text-[10px] font-medium transition-colors',
              rewriting
                ? 'border-zinc-700 text-zinc-500 cursor-wait'
                : 'border-violet-800/50 bg-violet-950/30 text-violet-400 hover:border-violet-600',
            )}
          >
            {rewriting ? 'AI 改写中...' : doc.derivedContent ? 'AI 重新改写' : 'AI 改写'}
          </button>
          {rewriting && rewriteProgress && rewriteProgress.segment > 0 && (
            <span className="text-[10px] text-zinc-500">
              续写 {rewriteProgress.segment} / {rewriteProgress.maxSegments}
            </span>
          )}
          {doc.derivedContent && (
            <label className="flex items-center gap-1 text-zinc-500 cursor-pointer">
              <input
                type="checkbox"
                checked={doc.useDerived ?? false}
                onChange={(e) => onMetaChange('useDerived', e.target.checked)}
                className="accent-violet-500"
              />
              <span className={doc.useDerived ? 'text-violet-400' : ''}>
                使用衍生版
              </span>
            </label>
          )}
        </>
      )}

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
  item: ScriptListItem;
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
          </div>
        )}
        <div className="text-[10px] text-zinc-600">
          {new Date(item.updatedAt).toLocaleDateString()}
        </div>
      </div>
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
    </div>
  );
}

