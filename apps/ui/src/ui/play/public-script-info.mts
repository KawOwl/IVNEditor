import type {
  BackgroundAsset,
  CharacterAsset,
  SceneState,
  ScriptManifest,
} from '@ivn/core/types';

/** 后端返回的公开剧本信息（脱敏，不含 prompt segments） */
export interface PublicScriptInfo {
  id: string;
  label: string;
  description?: string;
  coverImage?: string;
  author?: string;
  tags?: string[];
  chapterCount: number;
  firstChapterId: string | null;
  openingMessages?: string[];
  productionLlmConfigId?: string | null;
  /** M3 起：VN 资产（Step 1.2 补上透传路径，让前端 SpriteLayer 能查 displayName） */
  characters?: CharacterAsset[];
  backgrounds?: BackgroundAsset[];
  defaultScene?: SceneState;
}

/**
 * 从公开信息构造一个 "pseudo manifest"，供 PlayPage/PlayPanel 使用。
 * 内部字段（segments/stateSchema/memoryConfig）在 remote 模式下根本用不到，stub 即可。
 */
export function publicInfoToManifest(info: PublicScriptInfo): ScriptManifest {
  const {
    id,
    label,
    coverImage,
    description,
    author,
    tags,
    openingMessages,
    firstChapterId,
    characters,
    backgrounds,
    defaultScene,
  } = info;

  return {
    id,
    label,
    coverImage,
    description,
    author,
    tags,
    openingMessages,
    chapters: [createRemoteChapter(firstChapterId, label)],
    stateSchema: { variables: [] },
    memoryConfig: createRemoteMemoryConfig(),
    enabledTools: [],
    characters,
    backgrounds,
    defaultScene,
  };
}

function createRemoteChapter(
  firstChapterId: string | null,
  label: string,
): ScriptManifest['chapters'][number] {
  return {
    id: firstChapterId ?? 'ch1',
    label,
    segments: [],
    flowGraph: { id: 'stub', label: 'stub', nodes: [], edges: [] },
  };
}

function createRemoteMemoryConfig(): ScriptManifest['memoryConfig'] {
  return {
    contextBudget: 0,
    compressionThreshold: 0,
    recencyWindow: 0,
  };
}
