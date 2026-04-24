import type { ScriptRecord } from '@ivn/core/script-archive';
import type {
  BackgroundAsset,
  CharacterAsset,
  FlowGraph,
  MemoryConfig,
  SceneState,
  ScriptManifest,
  StateSchema,
} from '@ivn/core/types';
import { docToSegment, type EditorDocument } from './editor-documents';

export interface EditorManifestInput {
  id: string;
  label: string;
  description: string;
  tags: string[];
  stateSchema: StateSchema;
  memoryConfig: MemoryConfig;
  enabledTools: string[];
  initialPrompt: string;
  documents: EditorDocument[];
  promptAssemblyOrder?: string[];
  disabledAssemblySections: string[];
  characters: CharacterAsset[];
  backgrounds: BackgroundAsset[];
  defaultScene?: SceneState;
}

export interface EditorManifestOptions {
  chapterId?: string;
  chapterLabel?: string;
}

const DEFAULT_FLOW_GRAPH: FlowGraph = {
  id: 'draft-flow',
  label: '草稿',
  nodes: [],
  edges: [],
};

function createDraftFlowGraph(): FlowGraph {
  return {
    ...DEFAULT_FLOW_GRAPH,
    nodes: [],
    edges: [],
  };
}

function nonEmpty<T>(items: T[]): T[] | undefined {
  return items.length > 0 ? items : undefined;
}

function optionalText(text: string): string | undefined {
  return text || undefined;
}

export function buildEditorManifest(
  input: EditorManifestInput,
  options: EditorManifestOptions = {},
): ScriptManifest {
  return {
    id: input.id,
    label: input.label,
    description: input.description,
    tags: nonEmpty(input.tags),
    stateSchema: input.stateSchema,
    memoryConfig: input.memoryConfig,
    enabledTools: input.enabledTools,
    initialPrompt: optionalText(input.initialPrompt),
    promptAssemblyOrder: input.promptAssemblyOrder,
    disabledAssemblySections: nonEmpty(input.disabledAssemblySections),
    characters: nonEmpty(input.characters),
    backgrounds: nonEmpty(input.backgrounds),
    defaultScene: input.defaultScene,
    chapters: [{
      id: options.chapterId ?? 'ch1',
      label: options.chapterLabel ?? '第一章',
      flowGraph: createDraftFlowGraph(),
      segments: input.documents.map(docToSegment),
    }],
  };
}

export function buildEditorScriptRecord(input: EditorManifestInput): ScriptRecord {
  const now = Date.now();
  return {
    id: input.id,
    label: input.label,
    description: input.description,
    createdAt: now,
    updatedAt: now,
    manifest: buildEditorManifest(input),
  };
}
