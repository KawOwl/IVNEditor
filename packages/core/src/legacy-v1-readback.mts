import { applyScenePatchToState } from '#internal/game-session/scene-state';
import { createNarrationAccumulator } from '#internal/game-session/narration';
import { NarrativeParser } from '#internal/narrative-parser';
import {
  readChoices,
  readSelectedIndex,
  type NarrativeEntry,
} from '#internal/persistence-entry';
import { LEGACY_PROTOCOL_VERSION } from '#internal/protocol-version';
import type { ScenePatch } from '#internal/tool-executor';
import type { ParticipationFrame, SceneState, Sentence } from '#internal/types';

type LegacyV1Sprite = {
  id: string;
  emotion: string;
  position?: 'left' | 'center' | 'right';
};

export interface LegacyV1ReadbackOptions {
  readonly entries: ReadonlyArray<NarrativeEntry>;
  readonly initialScene?: SceneState;
  readonly initialTurn?: number;
  readonly startIndex?: number;
}

export interface LegacyV1ReadbackWarning {
  readonly code:
    | 'invalid-scene-tool-payload'
    | 'failed-scene-tool'
    | 'unknown-entry-kind';
  readonly entryId: string;
  readonly orderIdx: number;
  readonly message: string;
}

export interface LegacyV1ReadbackResult {
  readonly protocolVersion: typeof LEGACY_PROTOCOL_VERSION;
  readonly sentences: readonly Sentence[];
  readonly finalScene: SceneState;
  readonly nextTurn: number;
  readonly nextIndex: number;
  readonly warnings: readonly LegacyV1ReadbackWarning[];
}

/**
 * Reconstruct a readonly VN sentence stream from historical v1-tool-call
 * narrative_entries. This is a readback/migration boundary only; new runtime
 * sessions must use CoreEvent and the current declarative visual protocol.
 */
export function readLegacyV1Playthrough(
  options: LegacyV1ReadbackOptions,
): LegacyV1ReadbackResult {
  const reader = new LegacyV1ReadbackRuntime(options);
  return reader.read();
}

class LegacyV1ReadbackRuntime {
  private readonly entries: readonly NarrativeEntry[];
  private readonly sentences: Sentence[] = [];
  private readonly warnings: LegacyV1ReadbackWarning[] = [];
  private currentScene: SceneState;
  private currentTurn: number;
  private nextIndex: number;

  constructor(options: LegacyV1ReadbackOptions) {
    this.entries = [...options.entries].sort((a, b) => a.orderIdx - b.orderIdx);
    this.currentScene = copyScene(options.initialScene ?? { background: null, sprites: [] });
    this.currentTurn = options.initialTurn ?? 1;
    this.nextIndex = options.startIndex ?? 0;
  }

  read(): LegacyV1ReadbackResult {
    for (const entry of this.entries) {
      this.readEntry(entry);
    }

    return {
      protocolVersion: LEGACY_PROTOCOL_VERSION,
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
        this.readNarrative(entry.content);
        return;
      case 'tool_call':
        this.readToolCall(entry);
        return;
      case 'signal_input':
        this.readSignalInput(entry);
        return;
      case 'player_input':
        this.readPlayerInput(entry);
        return;
      default:
        this.warn(entry, 'unknown-entry-kind', `Unknown narrative entry kind "${entry.kind}"`);
    }
  }

  private readNarrative(content: string): void {
    const narrationAcc = createNarrationAccumulator((text) => {
      this.sentences.push({
        kind: 'narration',
        text,
        sceneRef: copyScene(this.currentScene),
        turnNumber: this.currentTurn,
        index: this.nextIndex,
      });
      this.nextIndex += 1;
    });

    const parser = new NarrativeParser({
      onNarrationChunk: (text) => narrationAcc.push(text),
      onDialogueStart: () => narrationAcc.flush(),
      onDialogueEnd: (pf, text, truncated) => {
        this.sentences.push({
          kind: 'dialogue',
          text,
          pf: copyParticipationFrame(pf),
          sceneRef: copyScene(this.currentScene),
          turnNumber: this.currentTurn,
          index: this.nextIndex,
          ...(truncated ? { truncated } : {}),
        });
        this.nextIndex += 1;
      },
    });

    parser.push(content);
    parser.finalize();
    narrationAcc.flush();
  }

  private readToolCall(entry: NarrativeEntry): void {
    const toolName = entry.content;
    if (!isVisualSceneTool(toolName)) return;

    const payload = entry.payload as { input?: unknown; output?: unknown } | null;
    if (isFailedToolOutput(payload?.output)) {
      this.warn(entry, 'failed-scene-tool', `Skipped failed ${toolName} tool call`);
      return;
    }

    const patch = createScenePatch(toolName, payload?.input);
    if (!patch) {
      this.warn(entry, 'invalid-scene-tool-payload', `Invalid ${toolName} payload`);
      return;
    }

    const applied = applyScenePatchToState(this.currentScene, patch);
    this.currentScene = copyScene(applied.scene);
    this.sentences.push({
      kind: 'scene_change',
      scene: copyScene(this.currentScene),
      ...(applied.transition !== undefined ? { transition: applied.transition } : {}),
      turnNumber: this.currentTurn,
      index: this.nextIndex,
    });
    this.nextIndex += 1;
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

  private warn(
    entry: NarrativeEntry,
    code: LegacyV1ReadbackWarning['code'],
    message: string,
  ): void {
    this.warnings.push({
      code,
      entryId: entry.id,
      orderIdx: entry.orderIdx,
      message,
    });
  }
}

function isVisualSceneTool(toolName: string): toolName is 'change_scene' | 'change_sprite' | 'clear_stage' {
  return toolName === 'change_scene' ||
    toolName === 'change_sprite' ||
    toolName === 'clear_stage';
}

function createScenePatch(toolName: string, input: unknown): ScenePatch | null {
  switch (toolName) {
    case 'change_scene':
      return createChangeScenePatch(input);
    case 'change_sprite':
      return createChangeSpritePatch(input);
    case 'clear_stage':
      return { kind: 'clear' };
    default:
      return null;
  }
}

function createChangeScenePatch(input: unknown): ScenePatch | null {
  if (!isRecord(input)) return null;
  const background = readOptionalString(input.background ?? input.bg);
  const sprites = readOptionalSprites(input.sprites);
  const transition = readOptionalTransition(input.transition);

  if (
    (input.background ?? input.bg) !== undefined && background === undefined ||
    input.sprites !== undefined && sprites === undefined ||
    input.transition !== undefined && transition === undefined
  ) {
    return null;
  }

  return {
    kind: 'full',
    ...(background !== undefined ? { background } : {}),
    ...(sprites !== undefined ? { sprites } : {}),
    ...(transition !== undefined ? { transition } : {}),
  };
}

function createChangeSpritePatch(input: unknown): ScenePatch | null {
  if (!isRecord(input)) return null;
  const character = readOptionalString(input.character ?? input.id);
  const emotion = readOptionalString(input.emotion);
  const position = readOptionalPosition(input.position);
  if (!character || !emotion) return null;
  if (input.position !== undefined && position === undefined) return null;

  return {
    kind: 'single-sprite',
    sprite: {
      id: character,
      emotion,
      ...(position !== undefined ? { position } : {}),
    },
  };
}

function readOptionalSprites(value: unknown): LegacyV1Sprite[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;

  const sprites = value.map(readSprite);
  return sprites.every((sprite): sprite is NonNullable<typeof sprite> => sprite !== null)
    ? sprites
    : undefined;
}

function readSprite(value: unknown): LegacyV1Sprite | null {
  if (!isRecord(value)) return null;
  const id = readOptionalString(value.id ?? value.character);
  const emotion = readOptionalString(value.emotion);
  const position = readOptionalPosition(value.position);
  if (!id || !emotion) return null;
  if (value.position !== undefined && position === undefined) return null;
  return {
    id,
    emotion,
    ...(position !== undefined ? { position } : {}),
  };
}

function isFailedToolOutput(value: unknown): boolean {
  return isRecord(value) && value.success === false;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readOptionalPosition(value: unknown): 'left' | 'center' | 'right' | undefined {
  return value === 'left' || value === 'center' || value === 'right'
    ? value
    : undefined;
}

function readOptionalTransition(value: unknown): 'fade' | 'cut' | 'dissolve' | undefined {
  return value === 'fade' || value === 'cut' || value === 'dissolve'
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
