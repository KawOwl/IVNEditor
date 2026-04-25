import { readCurrentPlaythrough } from '@ivn/core/current-readback';
import { readLegacyV1Playthrough } from '@ivn/core/legacy-v1-readback';
import { buildParserManifest } from '@ivn/core/narrative-parser-v2';
import {
  CURRENT_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  type ProtocolVersion,
} from '@ivn/core/protocol-version';
import type { NarrativeEntry } from '@ivn/core/persistence-entry';
import type { SceneState, ScriptManifest, Sentence } from '@ivn/core/types';
import type { NarrativeEntryRow } from '#internal/services/playthrough-service';

interface ReadbackPageOptions {
  readonly manifest: ScriptManifest;
  readonly prefixEntries?: readonly NarrativeEntryRow[];
  readonly pageEntries: readonly NarrativeEntryRow[];
  readonly offset: number;
  readonly limit: number;
  readonly totalEntries: number;
}

export interface ClientReadbackPage {
  readonly sentences: readonly Sentence[];
  readonly offset: number;
  readonly limit: number;
  readonly totalEntries: number;
  readonly hasMore: boolean;
  readonly nextOffset: number;
}

const EMPTY_SCENE: SceneState = { background: null, sprites: [] };
const CURRENT_PROTOCOL_TAGS = /<(?:dialogue|narration|scratch)(?:\s|>|\/)/i;

export function projectReadbackPage(options: ReadbackPageOptions): ClientReadbackPage {
  const prefixEntries = [...(options.prefixEntries ?? [])];
  const pageEntries = [...options.pageEntries];
  const protocolVersion = resolveReadbackProtocol(options.manifest, [
    ...prefixEntries,
    ...pageEntries,
  ]);
  const initialScene = copyScene(options.manifest.defaultScene ?? EMPTY_SCENE);
  const prefix = readEntries(protocolVersion, options.manifest, prefixEntries, {
    initialScene,
  });
  const page = readEntries(protocolVersion, options.manifest, pageEntries, {
    initialScene: prefix.finalScene,
    initialTurn: prefix.nextTurn,
    startIndex: prefix.nextIndex,
  });

  return {
    sentences: page.sentences,
    offset: options.offset,
    limit: options.limit,
    totalEntries: options.totalEntries,
    hasMore: options.offset + pageEntries.length < options.totalEntries,
    nextOffset: options.offset + pageEntries.length,
  };
}

function resolveReadbackProtocol(
  manifest: ScriptManifest,
  entries: readonly NarrativeEntryRow[],
): ProtocolVersion {
  if (manifest.protocolVersion) return manifest.protocolVersion;
  return entries.some((entry) =>
    entry.kind === 'narrative' && CURRENT_PROTOCOL_TAGS.test(entry.content))
    ? CURRENT_PROTOCOL_VERSION
    : LEGACY_PROTOCOL_VERSION;
}

function readEntries(
  protocolVersion: ProtocolVersion,
  manifest: ScriptManifest,
  entries: readonly NarrativeEntryRow[],
  options: {
    readonly initialScene: SceneState;
    readonly initialTurn?: number;
    readonly startIndex?: number;
  },
): {
  readonly sentences: readonly Sentence[];
  readonly finalScene: SceneState;
  readonly nextTurn: number;
  readonly nextIndex: number;
} {
  if (protocolVersion === LEGACY_PROTOCOL_VERSION) {
    return readLegacyV1Playthrough({
      entries: entries as unknown as NarrativeEntry[],
      initialScene: options.initialScene,
      initialTurn: options.initialTurn,
      startIndex: options.startIndex,
    });
  }

  return readCurrentPlaythrough({
    entries: entries as unknown as NarrativeEntry[],
    parserManifest: buildParserManifest(manifest),
    initialScene: options.initialScene,
    initialTurn: options.initialTurn,
    startIndex: options.startIndex,
  });
}

function copyScene(scene: SceneState): SceneState {
  return {
    background: scene.background,
    sprites: scene.sprites.map((sprite) => ({ ...sprite })),
  };
}
