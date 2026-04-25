import { useCallback, useMemo, useState } from 'react';
import type {
  BackgroundAsset,
  CharacterAsset,
  MemoryConfig,
  ProtocolVersion,
  SceneState,
  ScriptManifest,
  StateSchema,
} from '@ivn/core/types';
import type { StateVarInfo } from '@/lib/editor/completion-sources';
import {
  createEmptyEditorDocument,
  defaultEnabledTools,
  defaultMemoryConfig,
  defaultStateSchema,
  docToSegment,
  manifestToDocuments,
  readEditorDocumentsFromFiles,
  type EditorDocument,
  type EditorDocumentMetaField,
} from '#internal/ui/editor/editor-documents';
import {
  buildEditorManifest,
  type EditorManifestInput,
} from '#internal/ui/editor/editor-manifest';

export interface EditorRecordSnapshot {
  id: string;
  label: string;
  description: string;
  published?: boolean;
  manifest: ScriptManifest;
  productionLlmConfigId?: string | null;
}

export function useEditorDraftState() {
  const [documents, setDocuments] = useState<EditorDocument[]>([]);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [initialPrompt, setInitialPrompt] = useState('开始测试');
  const [stateSchema, setStateSchema] = useState<StateSchema>(defaultStateSchema);
  const [memoryConfig, setMemoryConfig] = useState<MemoryConfig>(defaultMemoryConfig);
  const [enabledTools, setEnabledTools] = useState<string[]>(() => [...defaultEnabledTools]);
  const [loadedScriptId, setLoadedScriptId] = useState<string | null>(null);
  const [scriptLabel, setScriptLabel] = useState('未命名剧本');
  const [scriptDescription, setScriptDescription] = useState('');
  const [scriptTags, setScriptTags] = useState<string[]>([]);
  const [protocolVersion, setProtocolVersion] =
    useState<ProtocolVersion>('v2-declarative-visual');
  const [characters, setCharacters] = useState<CharacterAsset[]>([]);
  const [backgrounds, setBackgrounds] = useState<BackgroundAsset[]>([]);
  const [defaultScene, setDefaultScene] = useState<SceneState | undefined>(undefined);
  const [isPublished, setIsPublished] = useState(false);
  const [promptAssemblyOrder, setPromptAssemblyOrder] = useState<string[] | undefined>(undefined);
  const [disabledAssemblySections, setDisabledAssemblySections] = useState<string[]>([]);
  const [productionLlmConfigId, setProductionLlmConfigId] = useState<string | null>(null);

  const selectedDoc = documents.find((doc) => doc.id === selectedDocId) ?? null;

  const createManifestInput = useCallback((id: string): EditorManifestInput => ({
    id,
    label: scriptLabel,
    description: scriptDescription,
    tags: scriptTags,
    stateSchema,
    memoryConfig,
    enabledTools,
    initialPrompt,
    protocolVersion,
    documents,
    promptAssemblyOrder,
    disabledAssemblySections,
    characters,
    backgrounds,
    defaultScene,
  }), [
    scriptLabel,
    scriptDescription,
    scriptTags,
    stateSchema,
    memoryConfig,
    enabledTools,
    initialPrompt,
    protocolVersion,
    documents,
    promptAssemblyOrder,
    disabledAssemblySections,
    characters,
    backgrounds,
    defaultScene,
  ]);

  const resetDraft = useCallback(() => {
    setDocuments([]);
    setSelectedDocId(null);
    setLoadedScriptId(null);
    setScriptLabel('未命名剧本');
    setScriptDescription('');
    setScriptTags([]);
    setStateSchema(defaultStateSchema);
    setMemoryConfig(defaultMemoryConfig);
    setEnabledTools([...defaultEnabledTools]);
    setInitialPrompt('开始测试');
    setProtocolVersion('v2-declarative-visual');
    setIsPublished(false);
    setPromptAssemblyOrder(undefined);
    setDisabledAssemblySections([]);
    setProductionLlmConfigId(null);
    setCharacters([]);
    setBackgrounds([]);
    setDefaultScene(undefined);
  }, []);

  const applyRecordToEditor = useCallback((record: EditorRecordSnapshot) => {
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
    setProtocolVersion(manifest.protocolVersion ?? 'v1-tool-call');
    setIsPublished(!!record.published);
    setPromptAssemblyOrder(manifest.promptAssemblyOrder);
    setDisabledAssemblySections(manifest.disabledAssemblySections ?? []);
    setProductionLlmConfigId(record.productionLlmConfigId ?? null);
    setCharacters(manifest.characters ?? []);
    setBackgrounds(manifest.backgrounds ?? []);
    setDefaultScene(manifest.defaultScene);
  }, []);

  const handleNewFile = useCallback(() => {
    const name = prompt('输入文件名（含 .md 后缀）:', '新文件.md');
    if (!name) return;
    const doc = createEmptyEditorDocument(name);
    setDocuments((prev) => [...prev, doc]);
    setSelectedDocId(doc.id);
  }, []);

  const handleFilesUpload = useCallback(async (files: FileList) => {
    const newDocs = await readEditorDocumentsFromFiles(files);
    if (newDocs.length > 0) {
      setDocuments((prev) => [...prev, ...newDocs]);
      setSelectedDocId((prev) => prev ?? newDocs[0]!.id);
    }
  }, []);

  const handleContentChange = useCallback((newContent: string) => {
    if (!selectedDocId) return;
    setDocuments((prev) =>
      prev.map((doc) => doc.id === selectedDocId ? { ...doc, content: newContent } : doc),
    );
  }, [selectedDocId]);

  const handleDeleteDoc = useCallback((id: string) => {
    setDocuments((prev) => prev.filter((doc) => doc.id !== id));
    setSelectedDocId((prev) => {
      if (prev !== id) return prev;
      const remaining = documents.filter((doc) => doc.id !== id);
      return remaining.length > 0 ? remaining[0]!.id : null;
    });
  }, [documents]);

  const handleDocMetaChange = useCallback((
    id: string,
    field: EditorDocumentMetaField,
    value: string | number | boolean,
  ) => {
    setDocuments((prev) =>
      prev.map((doc) => doc.id === id ? { ...doc, [field]: value } : doc),
    );
  }, []);

  const handleClearDerivedDoc = useCallback((id: string) => {
    setDocuments((prev) =>
      prev.map((doc) =>
        doc.id === id
          ? { ...doc, derivedContent: undefined, useDerived: false }
          : doc,
      ),
    );
  }, []);

  const segments = useMemo(
    () => documents.map(docToSegment),
    [documents],
  );

  const tokenCount = useMemo(
    () => segments.reduce((sum, segment) => sum + segment.tokenCount, 0),
    [segments],
  );

  const stateVars = useMemo<StateVarInfo[]>(
    () => stateSchema.variables.map((variable) => ({
      name: variable.name,
      type: variable.type,
      description: variable.description,
    })),
    [stateSchema],
  );

  const playManifest = useMemo<ScriptManifest>(() => {
    return buildEditorManifest(
      createManifestInput(loadedScriptId ?? 'editor-draft'),
      { chapterId: 'draft-ch1', chapterLabel: '草稿章节' },
    );
  }, [createManifestInput, loadedScriptId]);

  return {
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
    protocolVersion,
    setProtocolVersion,
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
  };
}
