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
type SessionMessageHandler = (msg: WSMessage, context: SessionMessageContext) => void;

interface SessionMessageContext {
  store: GetGameStore;
  baseUrl: string;
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

const SESSION_MESSAGE_HANDLERS: Record<string, SessionMessageHandler> = {
  reset: handleResetMessage,
  status: handleStatusMessage,
  error: handleErrorMessage,
  'begin-streaming': handleBeginStreamingMessage,
  'text-chunk': handleTextChunkMessage,
  'reasoning-chunk': handleReasoningChunkMessage,
  restored: handleRestoredMessage,
  'tool-call': handleToolCallMessage,
  'input-hint': handleInputHintMessage,
  'input-type': handleInputTypeMessage,
  'update-debug': handleUpdateDebugMessage,
  sentence: handleSentenceMessage,
  'scene-change': handleSceneChangeMessage,
  'memory-retrieval': handleMemoryRetrievalMessage,
  // PR2 narrative-rewrite
  'rewrite-attempted': handleRewriteAttemptedMessage,
  'rewrite-completed': handleRewriteCompletedMessage,
  'narrative-turn-reset': handleNarrativeTurnResetMessage,
  // 路线 A: retry-main 事件 — production UI 不消费，仅记录给 EditorDebugPanel /
  // 监控 dashboard 看决策路径。这里 noop 避免"unknown message type"误报。
  'retry-main-attempted': handleRetryMainAttemptedMessage,
  'retry-main-completed': handleRetryMainCompletedMessage,
};

export function handleSessionMessage(
  msg: WSMessage,
  store: GetGameStore,
  baseUrl: string,
): void {
  SESSION_MESSAGE_HANDLERS[msg.type]?.(msg, { store, baseUrl });
}

function resetServerNarrativeState(store: GetGameStore): void {
  const state = store();
  state.setStatus('idle');
  state.setError(null);
  state.setInputHint(null);
  state.setInputType('freetext', null);
}

function handleResetMessage(_msg: WSMessage, { store }: SessionMessageContext): void {
  resetServerNarrativeState(store);
}

function handleStatusMessage(msg: WSMessage, { store }: SessionMessageContext): void {
  applyStatus(msg.status, store);
}

function handleErrorMessage(msg: WSMessage, { store }: SessionMessageContext): void {
  store().setError(readNullableString(msg.error));
}

function handleBeginStreamingMessage(): void {
  useRawStreamingStore.getState().beginNew();
}

function handleTextChunkMessage(msg: WSMessage): void {
  useRawStreamingStore.getState().append(readString(msg.text) ?? '');
}

function handleReasoningChunkMessage(msg: WSMessage): void {
  useRawStreamingStore.getState().appendReasoning(readString(msg.text) ?? '');
}

function handleRestoredMessage(
  msg: WSMessage,
  { store, baseUrl }: SessionMessageContext,
): void {
  restoreSessionSnapshot(msg, store, baseUrl);
}

function handleToolCallMessage(msg: WSMessage, { store }: SessionMessageContext): void {
  appendToolCall(msg, store);
}

function handleInputHintMessage(msg: WSMessage, { store }: SessionMessageContext): void {
  store().setInputHint(readNullableString(msg.hint));
}

function handleInputTypeMessage(msg: WSMessage, { store }: SessionMessageContext): void {
  applyInputType(msg, store);
}

function handleUpdateDebugMessage(msg: WSMessage, { store }: SessionMessageContext): void {
  store().updateDebug(msg as Parameters<GameState['updateDebug']>[0]);
}

function handleSentenceMessage(msg: WSMessage, { store }: SessionMessageContext): void {
  store().appendSentence(msg.sentence as Sentence);
}

function handleSceneChangeMessage(msg: WSMessage, { store }: SessionMessageContext): void {
  applySceneChange(msg, store);
}

/**
 * PR2：narrative-rewrite 阶段开始。UI 切换 isRewriting=true 显示 loading 全
 * 覆盖（PR2 最简版）/ 半透明遮罩（PR3）。
 */
function handleRewriteAttemptedMessage(_msg: WSMessage, { store }: SessionMessageContext): void {
  store().setRewriting(true);
}

/**
 * PR2：narrative-rewrite 阶段结束。无论 ok 还是 fallback 都把 isRewriting 翻 false。
 * 如果 applied=true，narrative-turn-reset 已经先 emit 过、UI 清掉了 turn N 的
 * sentence，这里只负责揭开遮罩。
 */
function handleRewriteCompletedMessage(_msg: WSMessage, { store }: SessionMessageContext): void {
  store().setRewriting(false);
}

/**
 * 路线 A：retry-main 触发——server 端在 sentenceCount=0 case 跑了一次"重新生成
 * 主路径"。production UI 当前不消费此事件（最终 finalText 由 narrative-batch-emitted
 * 统一推过来），保留 noop 让 message dispatcher 不报 unknown type。
 */
function handleRetryMainAttemptedMessage(_msg: WSMessage, _context: SessionMessageContext): void {
  // noop
}

/**
 * 路线 A：retry-main 完成——同 attempted。production UI 用 status='generating'
 * + DialogBox 小齿轮覆盖整个 finalize 阶段，不需要单独的 retry-main UI。
 */
function handleRetryMainCompletedMessage(_msg: WSMessage, _context: SessionMessageContext): void {
  // noop
}

/**
 * PR2：rewrite 替换前，server 通知 UI 清掉本 turn 已经 stream 出来的 sentence。
 * 紧接着会有新一波 sentence WS message 重新填充（rewrite text → parser-v2 → emit）。
 * UI 用 parsedSentences 的最大 turnNumber 当作"当前 turn"清掉。
 */
function handleNarrativeTurnResetMessage(_msg: WSMessage, { store }: SessionMessageContext): void {
  const state = store();
  const sentences = state.parsedSentences;
  if (sentences.length === 0) return;
  let maxTurn = -Infinity;
  for (const s of sentences) {
    const tn = (s as { turnNumber?: number }).turnNumber;
    if (typeof tn === 'number' && tn > maxTurn) maxTurn = tn;
  }
  if (maxTurn === -Infinity) return;
  state.resetTurnSentences(maxTurn);
}

/**
 * ANN.1：每次 server 端 Memory.retrieve 后通过 'memory-retrieval' WS 消息广播。
 * 客户端塞进 game-store.memoryRetrievals，MemoryPanel 消费。
 */
function handleMemoryRetrievalMessage(msg: WSMessage, { store }: SessionMessageContext): void {
  const retrievalId = readString(msg.retrievalId);
  const turn = readNumber(msg.turn);
  const sourceRaw = readString(msg.source);
  const source = sourceRaw === 'tool-call' ? 'tool-call' : 'context-assembly';
  const query = readString(msg.query) ?? '';
  const summary = readString(msg.summary) ?? '';
  if (!retrievalId || turn === null) return;

  const entriesRaw = Array.isArray(msg.entries) ? msg.entries : [];
  const entries = entriesRaw
    .filter((e): e is Record<string, unknown> => isRecord(e))
    .map((e) => ({
      id: readString(e.id) ?? '',
      turn: readNumber(e.turn) ?? -1,
      role: readString(e.role) ?? 'system',
      content: readString(e.content) ?? '',
      tokenCount: readNumber(e.tokenCount) ?? 0,
      timestamp: readNumber(e.timestamp) ?? 0,
      pinned: typeof e.pinned === 'boolean' ? e.pinned : undefined,
    }))
    .filter((e) => e.id.length > 0);

  store().appendMemoryRetrieval({
    retrievalId,
    turn,
    source,
    query,
    entries,
    summary,
  });
}

function restoreSessionSnapshot(
  msg: WSMessage,
  store: GetGameStore,
  baseUrl: string,
): void {
  store().reset();

  const initialSentences = readSentences(msg.sentences);
  const restoredScene = readSceneState(msg.currentScene);
  const replay = (sentences: Sentence[]) => {
    appendSentences(sentences, store);
  };

  replay(initialSentences);
  if (restoredScene) {
    store().setCurrentScene(restoredScene);
  } else if (initialSentences.length === 0) {
    store().setCurrentScene(DEFAULT_SCENE);
  }
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
    offset: readNumber(msg.nextOffset) ?? 0,
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

function appendToolCall(msg: WSMessage, store: GetGameStore): void {
  store().addToolCall({
    name: readString(msg.name) ?? 'unknown',
    args: readRecord(msg.args) ?? {},
    result: undefined,
  });
}

function applySceneChange(msg: WSMessage, store: GetGameStore): void {
  store().setCurrentScene(
    readSceneState(msg.scene) ?? DEFAULT_SCENE,
    readTransition(msg.transition),
  );
}

function appendSentences(sentences: Sentence[], store: GetGameStore): void {
  for (const sentence of sentences) {
    store().appendSentence(sentence);
  }
}

interface FetchRemainingEntriesOptions {
  baseUrl: string;
  playthroughId: string;
  offset: number;
  replay: (sentences: Sentence[]) => void;
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

    let pageData: { sentences: Sentence[]; hasMore: boolean; nextOffset: number };
    try {
      pageData = readEntryPage(await res.json());
    } catch (err) {
      console.error('[restored] fetchMore parse error:', err);
      break;
    }

    if (pageData.nextOffset <= offset) break;

    options.replay(pageData.sentences);
    offset = pageData.nextOffset;

    if (!pageData.hasMore) break;
  }

  options.finalizeCursor();
}

function readEntryPage(value: unknown): { sentences: Sentence[]; hasMore: boolean; nextOffset: number } {
  if (!isRecord(value)) return { sentences: [], hasMore: false, nextOffset: 0 };
  return {
    sentences: readSentences(value.sentences),
    hasMore: Boolean(value.hasMore),
    nextOffset: readNumber(value.nextOffset) ?? 0,
  };
}

function readSentences(value: unknown): Sentence[] {
  return Array.isArray(value) ? value as Sentence[] : [];
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

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
