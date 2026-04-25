import {
  createParser as createParserV2,
  type DegradeEvent,
  type ParserManifest,
} from '#internal/narrative-parser-v2';
import {
  readChoices,
  readSelectedIndex,
  type NarrativeEntry,
} from '#internal/persistence-entry';
import { CURRENT_PROTOCOL_VERSION } from '#internal/protocol-version';
import type { ParticipationFrame, SceneState, Sentence } from '#internal/types';

export interface CurrentReadbackOptions {
  readonly entries: ReadonlyArray<NarrativeEntry>;
  readonly parserManifest: ParserManifest;
  readonly initialScene?: SceneState;
  readonly initialTurn?: number;
  readonly startIndex?: number;
}

export interface CurrentReadbackWarning {
  readonly code:
    | 'parser-degrade'
    | 'unexpected-tool-call'
    | 'unknown-entry-kind';
  readonly entryId: string;
  readonly orderIdx: number;
  readonly message: string;
  readonly detail?: string;
}

export interface CurrentReadbackResult {
  readonly protocolVersion: typeof CURRENT_PROTOCOL_VERSION;
  readonly sentences: readonly Sentence[];
  readonly finalScene: SceneState;
  readonly nextTurn: number;
  readonly nextIndex: number;
  readonly warnings: readonly CurrentReadbackWarning[];
}

/**
 * Reconstruct a readonly VN sentence stream from current declarative-visual
 * narrative_entries. This is the server readback boundary for reloads and
 * paginated history; live runtime remains CoreEvent/Sentence based.
 */
export function readCurrentPlaythrough(
  options: CurrentReadbackOptions,
): CurrentReadbackResult {
  const reader = new CurrentReadbackRuntime(options);
  return reader.read();
}

class CurrentReadbackRuntime {
  private readonly entries: readonly NarrativeEntry[];
  private readonly parserManifest: ParserManifest;
  private readonly sentences: Sentence[] = [];
  private readonly warnings: CurrentReadbackWarning[] = [];
  private currentScene: SceneState;
  private currentTurn: number;
  private nextIndex: number;

  constructor(options: CurrentReadbackOptions) {
    this.entries = [...options.entries].sort((a, b) => a.orderIdx - b.orderIdx);
    this.parserManifest = options.parserManifest;
    this.currentScene = copyScene(options.initialScene ?? { background: null, sprites: [] });
    this.currentTurn = options.initialTurn ?? 1;
    this.nextIndex = options.startIndex ?? 0;
  }

  read(): CurrentReadbackResult {
    for (const entry of this.entries) {
      this.readEntry(entry);
    }

    return {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      sentences: this.sentences.map(copySentence),
      finalScene: copyScene(this.currentScene),
      nextTurn: this.currentTurn,
      nextIndex: this.nextIndex,
      warnings: this.warnings.map((warning) => ({ ...warning })),
    };
  }

  private readEntry(entry: NarrativeEntry): void {
    switch (entry.kind) {
      case 'narrative':
        this.readNarrative(entry);
        return;
      case 'signal_input':
        this.readSignalInput(entry);
        return;
      case 'player_input':
        this.readPlayerInput(entry);
        return;
      case 'tool_call':
        this.warn(entry, 'unexpected-tool-call', `Skipped current protocol tool call "${entry.content}"`);
        return;
      default:
        this.warn(entry, 'unknown-entry-kind', `Unknown narrative entry kind "${entry.kind}"`);
    }
  }

  private readNarrative(entry: NarrativeEntry): void {
    const parser = createParserV2({
      manifest: this.parserManifest,
      turnNumber: this.currentTurn,
      startIndex: this.nextIndex,
      initialScene: this.currentScene,
    });

    const feedBatch = parser.feed(entry.content);
    const finalBatch = parser.finalize();
    this.sentences.push(...feedBatch.sentences.map(copySentence));
    this.sentences.push(...finalBatch.sentences.map(copySentence));
    for (const degrade of [...feedBatch.degrades, ...finalBatch.degrades]) {
      this.warnParserDegrade(entry, degrade);
    }

    const snapshot = parser.snapshot();
    this.currentScene = copyScene(snapshot.lastScene);
    this.nextIndex = snapshot.nextIndex;
  }

  private readSignalInput(entry: NarrativeEntry): void {
    this.sentences.push({
      kind: 'signal_input',
      hint: entry.content,
      choices: readChoices(entry),
      sceneRef: copyScene(this.currentScene),
      turnNumber: this.currentTurn,
      index: this.nextIndex,
    });
    this.nextIndex += 1;
  }

  private readPlayerInput(entry: NarrativeEntry): void {
    const selectedIndex = readSelectedIndex(entry);
    this.sentences.push({
      kind: 'player_input',
      text: entry.content,
      ...(selectedIndex !== undefined ? { selectedIndex } : {}),
      sceneRef: copyScene(this.currentScene),
      turnNumber: this.currentTurn,
      index: this.nextIndex,
    });
    this.nextIndex += 1;
    this.currentTurn += 1;
  }

  private warnParserDegrade(entry: NarrativeEntry, degrade: DegradeEvent): void {
    this.warn(
      entry,
      'parser-degrade',
      `Declarative parser degraded: ${degrade.code}`,
      degrade.detail,
    );
  }

  private warn(
    entry: NarrativeEntry,
    code: CurrentReadbackWarning['code'],
    message: string,
    detail?: string,
  ): void {
    this.warnings.push({
      code,
      entryId: entry.id,
      orderIdx: entry.orderIdx,
      message,
      ...(detail !== undefined ? { detail } : {}),
    });
  }
}

function copyScene(scene: SceneState): SceneState {
  return {
    background: scene.background,
    sprites: scene.sprites.map((sprite) => ({ ...sprite })),
  };
}

function copyParticipationFrame(pf: ParticipationFrame): ParticipationFrame {
  return {
    speaker: pf.speaker,
    ...(pf.addressee ? { addressee: [...pf.addressee] } : {}),
    ...(pf.overhearers ? { overhearers: [...pf.overhearers] } : {}),
    ...(pf.eavesdroppers ? { eavesdroppers: [...pf.eavesdroppers] } : {}),
  };
}

function copySentence(sentence: Sentence): Sentence {
  if (sentence.kind === 'narration') {
    return { ...sentence, sceneRef: copyScene(sentence.sceneRef) };
  }

  if (sentence.kind === 'dialogue') {
    return {
      ...sentence,
      pf: copyParticipationFrame(sentence.pf),
      sceneRef: copyScene(sentence.sceneRef),
    };
  }

  if (sentence.kind === 'scene_change') {
    return { ...sentence, scene: copyScene(sentence.scene) };
  }

  return { ...sentence, sceneRef: copyScene(sentence.sceneRef) };
}
