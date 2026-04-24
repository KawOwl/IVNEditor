import { NarrativeParser } from '@ivn/core/narrative-parser';
import type { SceneState, Sentence } from '@ivn/core/types';

import type { GameState } from '#internal/stores/game-store';
import { fetchWithAuth } from '#internal/stores/player-session-store';
import { useRawStreamingStore } from '#internal/stores/raw-streaming-store';

export interface WSMessage {
  type: string;
  [key: string]: unknown;
}

type GetGameStore = () => GameState;
type SessionStatus = GameState['status'];
type SpritePosition = NonNullable<SceneState['sprites'][number]['position']>;

interface EntryRow {
  role: string;
  kind?: string;
  content: string;
  payload?: Record<string, unknown> | null;
}

interface ReplayState {
  globalIndex: number;
  turnNumber: number;
}

const DEFAULT_SCENE: SceneState = { background: null, sprites: [] };
const PAGE_SIZE = 200;
const MAX_PAGES = 50;

const SESSION_STATUSES = new Set<SessionStatus>([
  'idle',
  'loading',
  'generating',
  'waiting-input',
  'compressing',
  'error',
  'finished',
]);

const SPRITE_POSITIONS = new Set<SpritePosition>(['left', 'center', 'right']);

export function handleSessionMessage(
  msg: WSMessage,
  store: GetGameStore,
  baseUrl: string,
): void {
  switch (msg.type) {
    case 'reset':
      resetServerNarrativeState(store);
      break;

    case 'status':
      applyStatus(msg.status, store);
      break;

    case 'error':
      store().setError(readNullableString(msg.error));
      break;

    case 'begin-streaming':
      useRawStreamingStore.getState().beginNew();
      break;

    case 'text-chunk':
      useRawStreamingStore.getState().append(readString(msg.text) ?? '');
      break;

    case 'reasoning-chunk':
      useRawStreamingStore.getState().appendReasoning(readString(msg.text) ?? '');
      break;

    case 'finalize':
    case 'entry':
    case 'pending-tool-call':
    case 'tool-result':
    case 'pending-tool-result':
    case 'stage-pending-debug':
      break;

    case 'restored':
      restoreSessionSnapshot(msg, store, baseUrl);
      break;

    case 'tool-call':
      store().addToolCall({
        name: readString(msg.name) ?? 'unknown',
        args: readRecord(msg.args) ?? {},
        result: undefined,
      });
      break;

    case 'input-hint':
      store().setInputHint(readNullableString(msg.hint));
      break;

    case 'input-type':
      applyInputType(msg, store);
      break;

    case 'update-debug':
      store().updateDebug(msg as Parameters<GameState['updateDebug']>[0]);
      break;

    case 'sentence':
      store().appendSentence(msg.sentence as Sentence);
      break;

    case 'scene-change':
      store().setCurrentScene(
        readSceneState(msg.scene) ?? DEFAULT_SCENE,
        readTransition(msg.transition),
      );
      break;
  }
}

function resetServerNarrativeState(store: GetGameStore): void {
  const state = store();
  state.setStatus('idle');
  state.setError(null);
  state.setInputHint(null);
  state.setInputType('freetext', null);
}

function restoreSessionSnapshot(
  msg: WSMessage,
  store: GetGameStore,
  baseUrl: string,
): void {
  store().reset();

  const initialEntries = readEntryRows(msg.entries);
  const sceneRef = readSceneState(msg.currentScene) ?? DEFAULT_SCENE;
  const replayState: ReplayState = { globalIndex: 0, turnNumber: 0 };
  const replay = (entries: EntryRow[]) => {
    replayEntries(entries, store, sceneRef, replayState);
  };

  replay(initialEntries);
  store().setCurrentScene(sceneRef);
  applyRestoredInputState(msg, store);

  const restoredStatus = readStatus(msg.status);
  if (restoredStatus) store().setStatus(restoredStatus);

  const finalizeCursor = () => {
    const total = store().parsedSentences.length;
    if (total > 0) store().setVisibleSentenceIndex(total - 1);
  };

  const playthroughId = readString(msg.playthroughId);
  if (!msg.hasMore || !playthroughId) {
    finalizeCursor();
    return;
  }

  void fetchRemainingEntries({
    baseUrl,
    playthroughId,
    offset: initialEntries.length,
    replay,
    finalizeCursor,
  });
}

function applyRestoredInputState(msg: WSMessage, store: GetGameStore): void {
  const inputHint = readString(msg.inputHint);
  if (inputHint) store().setInputHint(inputHint);

  if (msg.inputType === 'choice') {
    store().setInputType('choice', readStringList(msg.choices));
    return;
  }

  store().setInputType('freetext', null);
}

function applyInputType(msg: WSMessage, store: GetGameStore): void {
  if (msg.inputType === 'choice') {
    store().setInputType('choice', readStringList(msg.choices));
    return;
  }

  store().setInputType('freetext', null);
}

function applyStatus(value: unknown, store: GetGameStore): void {
  const status = readStatus(value);
  if (status) store().setStatus(status);
}

function replayEntries(
  entries: EntryRow[],
  store: GetGameStore,
  sceneRef: SceneState,
  replayState: ReplayState,
): void {
  for (const entry of entries) {
    if (entry.kind === 'signal_input') {
      appendSignalInput(entry, store, sceneRef, replayState);
      continue;
    }

    if (entry.role === 'receive') {
      appendPlayerInput(entry, store, sceneRef, replayState);
      continue;
    }

    if (entry.role === 'generate') {
      replayState.turnNumber++;
      appendGeneratedNarrative(entry, store, sceneRef, replayState);
    }
  }
}

function appendSignalInput(
  entry: EntryRow,
  store: GetGameStore,
  sceneRef: SceneState,
  replayState: ReplayState,
): void {
  store().appendSentence({
    kind: 'signal_input',
    hint: entry.content,
    choices: readStringList(entry.payload?.choices),
    sceneRef,
    turnNumber: replayState.turnNumber,
    index: replayState.globalIndex++,
  });
}

function appendPlayerInput(
  entry: EntryRow,
  store: GetGameStore,
  sceneRef: SceneState,
  replayState: ReplayState,
): void {
  const selectedIndex = typeof entry.payload?.selectedIndex === 'number'
    ? entry.payload.selectedIndex
    : undefined;

  store().appendSentence({
    kind: 'player_input',
    text: entry.content,
    ...(selectedIndex !== undefined ? { selectedIndex } : {}),
    sceneRef,
    turnNumber: replayState.turnNumber,
    index: replayState.globalIndex++,
  });
}

function appendGeneratedNarrative(
  entry: EntryRow,
  store: GetGameStore,
  sceneRef: SceneState,
  replayState: ReplayState,
): void {
  const parser = new NarrativeParser({
    onNarrationChunk: (text) => {
      store().appendSentence({
        kind: 'narration',
        text,
        sceneRef,
        turnNumber: replayState.turnNumber,
        index: replayState.globalIndex++,
      });
    },
    onDialogueEnd: (pf, fullText, truncated) => {
      store().appendSentence({
        kind: 'dialogue',
        text: fullText,
        pf,
        sceneRef,
        turnNumber: replayState.turnNumber,
        index: replayState.globalIndex++,
        truncated,
      });
    },
  });

  parser.push(entry.content);
  parser.finalize();
}

interface FetchRemainingEntriesOptions {
  baseUrl: string;
  playthroughId: string;
  offset: number;
  replay: (entries: EntryRow[]) => void;
  finalizeCursor: () => void;
}

async function fetchRemainingEntries(options: FetchRemainingEntriesOptions): Promise<void> {
  let offset = options.offset;

  for (let page = 0; page < MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await fetchWithAuth(
        `${options.baseUrl}/api/playthroughs/${encodeURIComponent(options.playthroughId)}/entries?offset=${offset}&limit=${PAGE_SIZE}`,
      );
    } catch (err) {
      console.error('[restored] fetchMore network error:', err);
      break;
    }

    if (!res.ok) {
      console.error('[restored] fetchMore HTTP', res.status);
      break;
    }

    let pageData: { entries: EntryRow[]; hasMore: boolean };
    try {
      pageData = readEntryPage(await res.json());
    } catch (err) {
      console.error('[restored] fetchMore parse error:', err);
      break;
    }

    if (pageData.entries.length === 0) break;

    options.replay(pageData.entries);
    offset += pageData.entries.length;

    if (!pageData.hasMore) break;
  }

  options.finalizeCursor();
}

function readEntryPage(value: unknown): { entries: EntryRow[]; hasMore: boolean } {
  if (!isRecord(value)) return { entries: [], hasMore: false };
  return {
    entries: readEntryRows(value.entries),
    hasMore: Boolean(value.hasMore),
  };
}

function readEntryRows(value: unknown): EntryRow[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const role = readString(entry.role);
    const content = readString(entry.content);
    if (!role || content === null) return [];

    return [{
      role,
      content,
      kind: readString(entry.kind) ?? undefined,
      payload: readRecord(entry.payload),
    }];
  });
}

function readSceneState(value: unknown): SceneState | null {
  if (!isRecord(value)) return null;

  const sprites = Array.isArray(value.sprites)
    ? value.sprites.flatMap(readSpriteState)
    : [];

  return {
    background: readString(value.background),
    sprites,
  };
}

function readSpriteState(value: unknown): SceneState['sprites'] {
  if (!isRecord(value)) return [];

  const id = readString(value.id);
  const emotion = readString(value.emotion);
  if (!id || !emotion) return [];

  const position = readSpritePosition(value.position);
  return [position ? { id, emotion, position } : { id, emotion }];
}

function readSpritePosition(value: unknown): SpritePosition | undefined {
  return typeof value === 'string' && SPRITE_POSITIONS.has(value as SpritePosition)
    ? value as SpritePosition
    : undefined;
}

function readTransition(value: unknown): 'fade' | 'cut' | 'dissolve' | undefined {
  return value === 'fade' || value === 'cut' || value === 'dissolve'
    ? value
    : undefined;
}

function readStatus(value: unknown): SessionStatus | null {
  return typeof value === 'string' && SESSION_STATUSES.has(value as SessionStatus)
    ? value as SessionStatus
    : null;
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function readNullableString(value: unknown): string | null {
  return value === null ? null : readString(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
