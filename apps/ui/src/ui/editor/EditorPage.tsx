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

import { useState, useCallback, useEffect } from 'react';
import { useAppStore } from '@/stores/app-store';
import type { VersionSummary } from '#internal/ui/editor/VersionHistoryList';
import { exportScript, parseImportedScript } from '@ivn/core/script-archive';
import { useAuthStore } from '@/stores/auth-store';
import { useLLMConfigsStore } from '@/stores/llm-configs-store';
import { LocalBackupGate } from '#internal/ui/editor/LocalBackupGate';
import { buildEditorManifest, buildEditorScriptRecord } from '#internal/ui/editor/editor-manifest';
import {
  createScript,
  createScriptVersion,
  deleteScript,
  getScriptMeta,
  getScriptVersion,
  listMineScripts,
  listScriptVersions,
  publishScriptVersion,
  renameScript,
  updateScriptMetadata,
} from '#internal/ui/editor/editor-script-api';
import {
  EditorDocumentWorkspace,
} from '#internal/ui/editor/EditorDocumentWorkspace';
import { EditorHeader } from '#internal/ui/editor/EditorHeader';
import { EditorRightPanel, type RightTab } from '#internal/ui/editor/EditorRightPanel';
import { EditorSidebar } from '#internal/ui/editor/EditorSidebar';
import type { ScriptListItem } from '#internal/ui/editor/ScriptListEntry';
import { useAIRewrite } from '#internal/ui/editor/use-ai-rewrite';
import { useEditorDraftState } from '#internal/ui/editor/use-editor-draft-state';
import { usePlaytestLlmConfigId } from '#internal/ui/editor/use-playtest-llm-config';
import type { ScriptManifest } from '@ivn/core/types';

// ============================================================================
// EditorPage
// ============================================================================

export function EditorPage() {
  const goHome = useAppStore((s) => s.goHome);
  const [rightTab, setRightTab] = useState<RightTab>('prompt');

  const {
    documents,
    setDocuments,
    selectedDocId,
    setSelectedDocId,
    selectedDoc,
    initialPrompt,
    setInitialPrompt,
    stateSchema,
    setStateSchema,
    memoryConfig,
    setMemoryConfig,
    enabledTools,
    setEnabledTools,
    loadedScriptId,
    setLoadedScriptId,
    scriptLabel,
    setScriptLabel,
    scriptDescription,
    setScriptDescription,
    scriptTags,
    setScriptTags,
    characters,
    setCharacters,
    backgrounds,
    setBackgrounds,
    defaultScene,
    setDefaultScene,
    isPublished,
    setIsPublished,
    promptAssemblyOrder,
    setPromptAssemblyOrder,
    disabledAssemblySections,
    setDisabledAssemblySections,
    productionLlmConfigId,
    setProductionLlmConfigId,
    createManifestInput,
    resetDraft,
    applyRecordToEditor,
    handleNewFile,
    handleFilesUpload,
    handleContentChange,
    handleDeleteDoc,
    handleDocMetaChange,
    handleClearDerivedDoc,
    segments,
    tokenCount,
    stateVars,
    playManifest,
  } = useEditorDraftState();

  // --- Script library state ---
  const [scriptList, setScriptList] = useState<ScriptListItem[]>([]);
  const [showScriptLibrary, setShowScriptLibrary] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);

  // --- v2.6 version management state ---
  /** 当前编辑的 version id（6.3：只在 remote 模式下有意义） */
  const [loadedVersionId, setLoadedVersionId] = useState<string | null>(null);
  /** 版本列表（当前加载剧本的所有 version，按 versionNumber 降序） */
  const [versionList, setVersionList] = useState<VersionSummary[]>([]);
  const [versionListLoading, setVersionListLoading] = useState(false);
  /** 正在发布的 versionId（用于禁用按钮） */
  const [publishingVersionId, setPublishingVersionId] = useState<string | null>(null);

  const [playtestLlmConfigId, setPlaytestLlmConfigId] = usePlaytestLlmConfigId();

  // 拉取 llm_configs 列表（admin 登录后才能用）
  const llmConfigs = useLLMConfigsStore((s) => s.configs);
  const llmConfigsLoaded = useLLMConfigsStore((s) => s.loaded);
  const refreshLlmConfigs = useLLMConfigsStore((s) => s.refresh);
  useEffect(() => {
    if (!llmConfigsLoaded) refreshLlmConfigs().catch(() => {});
  }, [llmConfigsLoaded, refreshLlmConfigs]);

  const resetEditorDraft = useCallback(() => {
    resetDraft();
    setLoadedVersionId(null);
    setVersionList([]);
  }, [resetDraft]);

  // --- Load script list from GET /api/scripts/mine ---
  //
  // 6.6 后完全从后端读取（IndexedDB 已下线）。编辑器展示的是"我的所有
  // 剧本"——当前全管理员共用同一份 visible set，包含未发布 draft。
  const refreshScriptList = useCallback(async () => {
    try {
      const authHeader = useAuthStore.getState().getAuthHeader();
      const result = await listMineScripts(authHeader);
      if (!result.ok) {
        setScriptList([]);
        return;
      }
      setScriptList(
        result.data.scripts.map((s) => ({
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
      const result = await listScriptVersions(scriptId, authHeader);
      if (result.ok) {
        setVersionList(result.data.versions);
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
      const versionsResult = await listScriptVersions(scriptId, authHeader);
      if (!versionsResult.ok) {
        alert(`加载剧本失败 (${versionsResult.status})`);
        return;
      }
      const { versions } = versionsResult.data;
      const pick =
        versions.find((v) => v.status === 'draft') ??
        versions.find((v) => v.status === 'published') ??
        versions[0];
      if (!pick) {
        alert('该剧本还没有任何版本');
        return;
      }
      const versionResult = await getScriptVersion(pick.id, authHeader);
      if (!versionResult.ok) {
        alert(`加载版本失败 (${versionResult.status})`);
        return;
      }
      const version = versionResult.data;
      const scriptMetaResult = await getScriptMeta(scriptId, authHeader);
      const scriptMeta = scriptMetaResult.ok
        ? scriptMetaResult.data
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
      setShowScriptLibrary(false);
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
      const authHeader = useAuthStore.getState().getAuthHeader();
      let scriptId = loadedScriptId;

      // Step 1: 新建或同步元数据
      if (scriptId) {
        const patchResult = await updateScriptMetadata(
          scriptId,
          {
            label: scriptLabel,
            description: scriptDescription,
            productionLlmConfigId,
          },
          authHeader,
        );
        if (!patchResult.ok) {
          alert(`保存失败 (PATCH ${patchResult.status})`);
          return;
        }
      } else {
        const createResult = await createScript(
          {
            label: scriptLabel,
            description: scriptDescription,
            productionLlmConfigId,
          },
          authHeader,
        );
        if (!createResult.ok) {
          alert(`创建剧本失败 (${createResult.status})`);
          return;
        }
        const { id: newId } = createResult.data;
        scriptId = newId;
        setLoadedScriptId(newId);
      }

      const id = scriptId!;
      const manifest = buildEditorManifest(createManifestInput(id));

      // Step 2: POST 新版本
      const versionResult = await createScriptVersion(id, manifest, authHeader);
      if (!versionResult.ok) {
        alert(`保存版本失败 (${versionResult.status})`);
        return;
      }
      const { versionId, created } = versionResult.data;
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
  }, [loadedScriptId, scriptLabel, scriptDescription, productionLlmConfigId, createManifestInput, refreshScriptList, refreshVersionList]);

  // --- Delete a script ---
  // DELETE /api/scripts/:id（级联删 versions + playthroughs）
  const handleDeleteScript = useCallback(async (id: string) => {
    try {
      const authHeader = useAuthStore.getState().getAuthHeader();
      const result = await deleteScript(id, authHeader);
      if (!result.ok && result.status !== 404) {
        alert(`删除失败 (${result.status})`);
        return;
      }
    } catch (err) {
      console.error('[delete] 失败:', err);
      alert(`删除失败: ${err}`);
      return;
    }
    if (loadedScriptId === id) {
      resetEditorDraft();
    }
    await refreshScriptList();
  }, [loadedScriptId, refreshScriptList, resetEditorDraft]);

  // --- Rename a saved script ---
  // PATCH /api/scripts/:id
  const handleRenameScript = useCallback(async (id: string, newLabel: string) => {
    try {
      const authHeader = useAuthStore.getState().getAuthHeader();
      const result = await renameScript(id, newLabel, authHeader);
      if (!result.ok) {
        alert(`重命名失败 (${result.status})`);
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
    const id = loadedScriptId ?? 'export';
    const record = buildEditorScriptRecord(createManifestInput(id));
    const json = exportScript(record);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${scriptLabel}.ivn.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [loadedScriptId, scriptLabel, createManifestInput]);

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
      const createResult = await createScript(
        {
          label: record.label,
          description: record.description,
          productionLlmConfigId: null,
        },
        authHeader,
      );
      if (!createResult.ok) {
        alert(`导入失败 (创建剧本 ${createResult.status})`);
        return;
      }
      const { id: newId } = createResult.data;

      // Step 2: 用新 id 重写 manifest.id 后上传为首个版本
      const manifest: ScriptManifest = { ...record.manifest, id: newId };
      const versionResult = await createScriptVersion(newId, manifest, authHeader);
      if (!versionResult.ok) {
        alert(`导入失败 (创建版本 ${versionResult.status})`);
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
    resetEditorDraft();
    setShowScriptLibrary(false);
  }, [resetEditorDraft]);

  // --- Publish an arbitrary draft version（供版本历史列用）---
  //
  // POST /api/script-versions/:id/publish
  //   - 该 draft 变 published
  //   - 原 published 自动变 archived
  const handlePublishVersion = useCallback(async (versionId: string) => {
    setPublishingVersionId(versionId);
    try {
      const authHeader = useAuthStore.getState().getAuthHeader();
      const result = await publishScriptVersion(versionId, authHeader);
      if (!result.ok) {
        alert(`发布失败: ${result.text}`);
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
      const result = await getScriptVersion(versionId, authHeader);
      if (result.ok) {
        const version = result.data;
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

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files.length > 0) {
      handleFilesUpload(e.dataTransfer.files);
    }
  }, [handleFilesUpload]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const {
    rewritingDocId,
    rewriteProgress,
    rewriteDocument: handleAIRewrite,
  } = useAIRewrite({
    documents,
    setDocuments,
    playtestLlmConfigId,
  });

  return (
    <LocalBackupGate>
      <div className="h-full bg-zinc-950 text-zinc-100 flex flex-col">
      <EditorHeader
        scriptLabel={scriptLabel}
        loadedScriptId={loadedScriptId}
        documentCount={documents.length}
        tokenCount={tokenCount}
        publishing={publishing}
        isPublished={isPublished}
        onGoHome={goHome}
        onPublish={handlePublishScript}
      />

      {/* Main content */}
      <div
        className="flex-1 flex min-h-0"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        {/* Left: File sidebar + Editor */}
        <div className="flex-1 flex min-w-0">
          <EditorSidebar
            documents={documents}
            selectedDocId={selectedDocId}
            scriptLabel={scriptLabel}
            scriptList={scriptList}
            showScriptLibrary={showScriptLibrary}
            saving={saving}
            loadedScriptId={loadedScriptId}
            initialPrompt={initialPrompt}
            onShowScriptLibraryChange={setShowScriptLibrary}
            onSaveScript={handleSaveScript}
            onNewScript={handleNewScript}
            onImportScript={handleImportScript}
            onExportScript={handleExportScript}
            onLoadScript={handleLoadScript}
            onRenameScript={handleRenameScript}
            onDeleteScript={handleDeleteScript}
            onFilesUpload={handleFilesUpload}
            onNewFile={handleNewFile}
            onSelectDoc={setSelectedDocId}
            onDeleteDoc={handleDeleteDoc}
            onRenameDoc={(id, name) => handleDocMetaChange(id, 'filename', name)}
            onInitialPromptChange={setInitialPrompt}
          />

          <EditorDocumentWorkspace
            documentsCount={documents.length}
            selectedDoc={selectedDoc}
            loadedScriptId={loadedScriptId}
            loadedVersionId={loadedVersionId}
            versionList={versionList}
            versionListLoading={versionListLoading}
            publishingVersionId={publishingVersionId}
            stateVars={stateVars}
            rewritingDocId={rewritingDocId}
            rewriteProgress={rewriteProgress}
            onSelectVersion={handleSelectVersion}
            onPublishVersion={handlePublishVersion}
            onDocMetaChange={handleDocMetaChange}
            onContentChange={handleContentChange}
            onRewriteDoc={handleAIRewrite}
            onClearDerivedDoc={handleClearDerivedDoc}
          />
        </div>

        <EditorRightPanel
          activeTab={rightTab}
          onTabChange={setRightTab}
          segments={segments}
          stateSchema={stateSchema}
          memoryConfig={memoryConfig}
          enabledTools={enabledTools}
          initialPrompt={initialPrompt}
          promptAssemblyOrder={promptAssemblyOrder}
          disabledAssemblySections={disabledAssemblySections}
          playManifest={playManifest}
          loadedScriptId={loadedScriptId}
          loadedVersionId={loadedVersionId}
          scriptLabel={scriptLabel}
          scriptDescription={scriptDescription}
          scriptTags={scriptTags}
          productionLlmConfigId={productionLlmConfigId}
          playtestLlmConfigId={playtestLlmConfigId}
          llmConfigs={llmConfigs}
          characters={characters}
          backgrounds={backgrounds}
          defaultScene={defaultScene}
          onPromptAssemblyOrderChange={setPromptAssemblyOrder}
          onDisabledAssemblySectionsChange={setDisabledAssemblySections}
          onPlaytestLlmConfigIdChange={setPlaytestLlmConfigId}
          onLabelChange={setScriptLabel}
          onDescriptionChange={setScriptDescription}
          onTagsChange={setScriptTags}
          onStateSchemaChange={setStateSchema}
          onMemoryConfigChange={setMemoryConfig}
          onEnabledToolsChange={setEnabledTools}
          onInitialPromptChange={setInitialPrompt}
          onProductionLlmConfigIdChange={setProductionLlmConfigId}
          onCharactersChange={setCharacters}
          onBackgroundsChange={setBackgrounds}
          onDefaultSceneChange={setDefaultScene}
        />
      </div>
      </div>
    </LocalBackupGate>
  );
}
