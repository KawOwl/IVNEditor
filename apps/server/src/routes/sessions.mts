/**
 * Session Routes — 游玩会话 WebSocket
 *
 * 只保留一个 endpoint：WS /api/sessions/ws?sessionId=X&playthroughId=Y
 *
 * 创建 playthrough 走 POST /api/playthroughs（独立接口）。
 * 这里只负责 WebSocket 连接 → 建立内存 wrapper → 推流。
 *
 * 流程：
 *   1. 从 query 取 sessionId（player auth token）+ playthroughId
 *   2. 解析 sessionId → userId
 *   3. 校验 playthrough 归属该 userId（ownership）
 *   4. getOrCreate wrapper（按 playthroughId 索引）
 *   5. attachWebSocket + 自动 start / restore
 */

import { Elysia } from 'elysia';
import { SessionManager } from '#internal/session-manager';
import { playthroughService, type PlaythroughDetail } from '#internal/services/playthrough-service';
import { scriptVersionService } from '#internal/services/script-version-service';
import { llmConfigService, type LlmConfigRow } from '#internal/services/llm-config-service';
import { resolvePlayerSession } from '#internal/auth-identity';
import { coreEventLogService } from '#internal/services/core-event-log';
import { resolveRestorableSessionState } from '#internal/session-restore-input-state';
import { projectReadbackPage } from '#internal/session-readback';
import type { LLMConfig } from '@ivn/core/llm-client';
import { deriveCoreEventLogRestoreState } from '@ivn/core/game-session';
import type { ScriptManifest } from '@ivn/core/types';

const sessionManager = new SessionManager();

type SessionSocket = { send(data: string): void };
type ClosableSessionSocket = SessionSocket & { close(): void };

interface WsQuery {
  sessionId?: string;
  playthroughId?: string;
}

interface SessionOpenRequest {
  authSession: string;
  playthroughId: string;
}

interface SessionOpenContext {
  playthroughId: string;
  userId: string;
  detail: PlaythroughDetail;
  scriptVersionId: string;
  manifest: ScriptManifest;
  llmConfig: LLMConfig;
}

type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

const RESTORED_CLIENT_FIELDS = [
  'status',
  'turn',
  'stateVars',
  'inputHint',
  'inputType',
  'choices',
  'totalEntries',
  'hasMore',
  'currentScene',
] as const satisfies ReadonlyArray<keyof PlaythroughDetail>;

const RESTORE_WRAPPER_FIELDS = [
  'memorySnapshot',
  'status',
  'inputHint',
  'inputType',
  'choices',
] as const satisfies ReadonlyArray<keyof PlaythroughDetail>;

/** 从 Elysia WS 对象里读取 query 参数（handler 间 ws 引用可能变化，每次都重新读） */
function getWsQuery(ws: unknown): WsQuery {
  return ((ws as { data?: { query?: WsQuery } })?.data?.query ?? {}) as WsQuery;
}

function pickFields<T extends object, const K extends readonly (keyof T)[]>(
  source: T,
  keys: K,
): Pick<T, K[number]> {
  return Object.fromEntries(keys.map((key) => [key, source[key]])) as Pick<T, K[number]>;
}

function sendJson(ws: SessionSocket, payload: unknown): void {
  ws.send(JSON.stringify(payload));
}

function closeWithError(ws: ClosableSessionSocket, error: string): void {
  sendJson(ws, { type: 'error', error });
  ws.close();
}

function readSessionOpenRequest(ws: unknown): ValidationResult<SessionOpenRequest> {
  const { sessionId: authSession, playthroughId } = getWsQuery(ws);
  if (!authSession || !playthroughId) {
    return { ok: false, error: 'Missing sessionId or playthroughId' };
  }

  return { ok: true, value: { authSession, playthroughId } };
}

function toLlmConfig(row: LlmConfigRow): LLMConfig {
  return {
    provider: row.provider,
    baseURL: row.baseUrl,
    apiKey: row.apiKey,
    model: row.model,
    name: row.name,
    maxOutputTokens: row.maxOutputTokens,
    thinkingEnabled: row.thinkingEnabled,
    reasoningEffort: row.reasoningEffort as 'high' | 'max' | null,
  };
}

async function loadSessionOpenContext(
  request: SessionOpenRequest,
): Promise<ValidationResult<SessionOpenContext>> {
  const identity = await resolvePlayerSession(request.authSession);
  if (!identity) {
    return { ok: false, error: 'Invalid or expired session' };
  }

  const rawDetail = await playthroughService.getById(request.playthroughId, identity.userId, 50);
  if (!rawDetail) {
    return { ok: false, error: 'Playthrough not found' };
  }
  const detail = await normalizeRestorableDetail(rawDetail);

  const version = await scriptVersionService.getById(detail.scriptVersionId);
  if (!version) {
    return { ok: false, error: 'Script version not found' };
  }

  const llmConfigRow = await llmConfigService.getById(detail.llmConfigId);
  if (!llmConfigRow) {
    return { ok: false, error: 'LLM config not found for this playthrough' };
  }

  return {
    ok: true,
    value: {
      playthroughId: request.playthroughId,
      userId: identity.userId,
      detail,
      scriptVersionId: version.id,
      manifest: version.manifest,
      llmConfig: toLlmConfig(llmConfigRow),
    },
  };
}

async function normalizeRestorableDetail(detail: PlaythroughDetail): Promise<PlaythroughDetail> {
  const eventLogState = deriveCoreEventLogRestoreState(
    await coreEventLogService.load(detail.id),
    { sortBySequence: true },
  );
  const fromEventLog = eventLogState
    ? applyRestorableState(detail, {
        status: eventLogState.status,
        turn: eventLogState.turn,
        stateVars: eventLogState.stateVars,
        memorySnapshot: eventLogState.memorySnapshot,
        currentScene: eventLogState.currentScene,
        inputHint: eventLogState.inputHint,
        inputType: eventLogState.inputType,
        choices: eventLogState.choices,
      })
    : detail;

  if (eventLogState && fromEventLog.status !== 'waiting-input') return fromEventLog;
  if (!eventLogState && !['waiting-input', 'generating'].includes(fromEventLog.status)) return fromEventLog;

  const recentEntries = fromEventLog.hasMore
    ? await playthroughService.loadLatestEntries(fromEventLog.id, 100)
    : fromEventLog.entries;
  const sessionState = resolveRestorableSessionState(fromEventLog, recentEntries);
  const turnPatch =
    !eventLogState && fromEventLog.status === 'generating' && sessionState.status === 'idle'
      ? { turn: Math.max(0, fromEventLog.turn - 1) }
      : {};

  return applyRestorableState(fromEventLog, { ...sessionState, ...turnPatch });
}

function applyRestorableState(
  detail: PlaythroughDetail,
  patch: Partial<Pick<
    PlaythroughDetail,
    'status' | 'turn' | 'stateVars' | 'memorySnapshot' | 'currentScene' | 'inputHint' | 'inputType' | 'choices'
  >>,
): PlaythroughDetail {
  const next = { ...detail, ...patch };
  if (
    next.status === detail.status &&
    next.turn === detail.turn &&
    next.stateVars === detail.stateVars &&
    next.memorySnapshot === detail.memorySnapshot &&
    next.currentScene === detail.currentScene &&
    next.inputHint === detail.inputHint &&
    next.inputType === detail.inputType &&
    sameChoices(next.choices, detail.choices)
  ) {
    return detail;
  }
  return next;
}

function sameChoices(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((choice, index) => choice === b[index]);
}

async function attachSessionWrapper(ws: SessionSocket, context: SessionOpenContext) {
  const wrapper = sessionManager.getOrCreate(
    context.playthroughId,
    context.manifest,
    context.scriptVersionId,
    context.userId,
    context.detail.kind,
    context.llmConfig,
  );
  await wrapper.attachWebSocket(ws);
  return wrapper;
}

function isNewPlaythrough(detail: PlaythroughDetail): boolean {
  const { turn, totalEntries } = detail;
  return turn === 0 && totalEntries === 0;
}

function sendConnected(ws: SessionSocket, playthroughId: string): void {
  sendJson(ws, {
    type: 'connected',
    playthroughId,
  });
}

function restoreExistingPlaythrough(
  ws: SessionSocket,
  wrapper: ReturnType<typeof sessionManager.getOrCreate>,
  playthroughId: string,
  detail: PlaythroughDetail,
  manifest: ScriptManifest,
): void {
  const readback = projectReadbackPage({
    manifest,
    pageEntries: detail.entries,
    offset: 0,
    limit: detail.entries.length,
    totalEntries: detail.totalEntries,
  });

  sendJson(ws, {
    type: 'restored',
    playthroughId,
    ...pickFields(detail, RESTORED_CLIENT_FIELDS),
    ...readback,
  });

  wrapper.restore({
    stateVars: detail.stateVars ?? {},
    turn: detail.turn,
    ...pickFields(detail, RESTORE_WRAPPER_FIELDS),
    currentScene: detail.currentScene ?? null,
  });
}

async function connectSessionWebSocket(ws: SessionSocket, context: SessionOpenContext): Promise<void> {
  const wrapper = await attachSessionWrapper(ws, context);
  sendConnected(ws, context.playthroughId);

  if (!isNewPlaythrough(context.detail)) {
    restoreExistingPlaythrough(ws, wrapper, context.playthroughId, context.detail, context.manifest);
  }
}

async function openSessionWebSocket(ws: ClosableSessionSocket): Promise<void> {
  const request = readSessionOpenRequest(ws);
  if (!request.ok) {
    closeWithError(ws, request.error);
    return;
  }

  console.log(`[WS] open: pt=${request.value.playthroughId.substring(0, 8)}`);

  const context = await loadSessionOpenContext(request.value);
  if (!context.ok) {
    closeWithError(ws, context.error);
    return;
  }

  await connectSessionWebSocket(ws, context.value);
}

export const sessionRoutes = new Elysia({ prefix: '/api/sessions' })

  // ============================================================================
  // WS /ws — 统一的游戏会话入口
  //
  // Query params:
  //   sessionId      (必填): player auth token（= user_sessions.id）
  //   playthroughId  (必填): 要连接的游玩记录 ID
  //
  // 行为：
  //   - 校验 auth + ownership
  //   - playthrough.turn===0 && 无 entries → 新游戏，等客户端发 'start'
  //   - 否则 → 从 DB restore，自动推送 'restored' 快照
  // ============================================================================
  .ws('/ws', {
    async open(ws) {
      await openSessionWebSocket(ws);
    },

    message(ws, message) {
      const { playthroughId } = getWsQuery(ws);
      if (!playthroughId) return;

      const wrapper = sessionManager.get(playthroughId);
      if (!wrapper) return;

      try {
        const data = typeof message === 'string' ? JSON.parse(message) : message;
        console.log(`[WS] msg ${data.type} pt=${playthroughId.substring(0, 8)}`);

        switch (data.type) {
          case 'start':
            wrapper.start();
            break;
          case 'input':
            // submitInput 现在是 async（记忆模块重构后需要 await memory.appendTurn / snapshot）。
            // WS message handler 保持 sync，用 fire-and-forget + .catch 兜底，
            // 避免未处理 rejection 冒泡。
            wrapper.submitInput(data.text).catch((err) => {
              console.error('[WS] submitInput failed:', err);
              ws.send(JSON.stringify({ type: 'error', error: String(err) }));
            });
            break;
          case 'stop':
            wrapper.stop();
            break;
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', error: String(err) }));
      }
    },

    close(ws) {
      const { playthroughId } = getWsQuery(ws);
      if (!playthroughId) return;
      console.log(`[WS] close: pt=${playthroughId.substring(0, 8)}`);
      // 断线：不立即销毁，启动 TTL（10 分钟内重连可恢复）
      sessionManager.detach(playthroughId);
    },
  });
