/**
 * WebSocket Client Emitter — 前端接收后端 WS 事件并写入 Zustand
 *
 * 简化后的流程：
 *   - 新建游玩：POST /api/playthroughs → 拿 playthroughId → WS 连接
 *   - 恢复游玩：直接 WS 连接（服务端会自动发 'restored' 快照）
 *
 * WS URL 通过 query 传递：sessionId (auth) + playthroughId (游玩记录)
 */

import { useGameStore } from './game-store';
import { ensureSessionId, fetchWithAuth } from './player-session-store';

// ============================================================================
// Types
// ============================================================================

interface WSMessage {
  type: string;
  [key: string]: unknown;
}

export interface RemoteSession {
  /** Send player input */
  submitInput(text: string): void;
  /** Tell backend to start the game session (仅新游戏需要) */
  start(): void;
  /** Tell backend to stop the session */
  stop(): void;
  /** Close the WebSocket connection */
  disconnect(): void;
  /** Playthrough ID (for localStorage persistence) */
  playthroughId: string | null;
}

// ============================================================================
// localStorage helpers
// ============================================================================

const LS_KEY_PREFIX = 'ivn-playthrough-';

export function getStoredPlaythroughId(scriptId: string): string | null {
  try {
    const raw = localStorage.getItem(LS_KEY_PREFIX + scriptId);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data.playthroughId ?? null;
  } catch {
    return null;
  }
}

export function storePlaythroughId(scriptId: string, playthroughId: string): void {
  localStorage.setItem(LS_KEY_PREFIX + scriptId, JSON.stringify({
    playthroughId,
    timestamp: Date.now(),
  }));
}

export function clearStoredPlaythroughId(scriptId: string): void {
  localStorage.removeItem(LS_KEY_PREFIX + scriptId);
}

// ============================================================================
// Create new remote session
//
// 1. POST /api/playthroughs → 创建 playthrough 记录（拿 playthroughId）
// 2. WS 连接 → 新游戏流程
// ============================================================================

export interface CreateRemoteSessionOptions {
  /** 玩家正式游玩走 production；编辑器试玩走 playtest */
  kind?: 'production' | 'playtest';
}

export async function createRemoteSession(
  baseUrl: string,
  /**
   * 兼容两种入参：
   * - 玩家流：传 scriptId（剧本 id）→ 后端自动用当前 published 版本
   * - 编辑器试玩流：传 { scriptVersionId } → 后端用指定的 draft 版本
   */
  target: string | { scriptVersionId: string },
  options: CreateRemoteSessionOptions = {},
): Promise<RemoteSession> {
  const isVersionTarget = typeof target === 'object';
  const body = isVersionTarget
    ? { scriptVersionId: target.scriptVersionId, kind: options.kind ?? 'playtest' }
    : { scriptId: target, kind: options.kind ?? 'production' };

  // 1. 创建 playthrough
  const res = await fetchWithAuth(`${baseUrl}/api/playthroughs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error ?? `Failed to create playthrough: ${res.status}`);
  }

  const { id: playthroughId } = await res.json() as { id: string; title: string };

  // 存储 playthroughId 供下次重连
  // 编辑器试玩用 versionId 作为 storage key（每个版本独立的"上次试玩"）
  const storageKey = isVersionTarget ? `version:${target.scriptVersionId}` : target;
  storePlaythroughId(storageKey, playthroughId);

  // 2. WS 连接
  return connectWebSocket(baseUrl, playthroughId);
}

// ============================================================================
// Reconnect to existing playthrough
//
// 直接 WS 连接即可，服务端会自动发 'restored' 快照（如果 playthrough 有历史）
// ============================================================================

export async function reconnectRemoteSession(
  baseUrl: string,
  playthroughId: string,
): Promise<RemoteSession> {
  return connectWebSocket(baseUrl, playthroughId);
}

// ============================================================================
// Shared WebSocket connection logic
// ============================================================================

async function connectWebSocket(
  baseUrl: string,
  playthroughId: string,
): Promise<RemoteSession> {
  const store = () => useGameStore.getState();

  // 拿到 auth sessionId（player token）
  const authSessionId = await ensureSessionId();

  const wsProtocol = baseUrl.startsWith('https') ? 'wss' : 'ws';
  const wsHost = baseUrl.replace(/^https?:\/\//, '');
  const wsUrl = `${wsProtocol}://${wsHost}/api/sessions/ws?sessionId=${encodeURIComponent(authSessionId)}&playthroughId=${encodeURIComponent(playthroughId)}`;
  const ws = new WebSocket(wsUrl);

  return new Promise<RemoteSession>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket connection timeout'));
    }, 10000);

    ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data);
        handleMessage(msg, store);

        if (msg.type === 'connected') {
          clearTimeout(timeout);
          resolve(session);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('WebSocket connection failed'));
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      const { status } = store();
      if (status !== 'idle' && status !== 'error') {
        store().finalizeStreamingEntry();
        store().setInputHint(null);
        store().setInputType('freetext');
        store().setStatus('idle');
      }
    };

    const session: RemoteSession = {
      playthroughId,
      start() {
        ws.send(JSON.stringify({ type: 'start' }));
      },
      submitInput(text: string) {
        ws.send(JSON.stringify({ type: 'input', text }));
      },
      stop() {
        ws.send(JSON.stringify({ type: 'stop' }));
      },
      disconnect() {
        ws.close();
      },
    };
  });
}

// ============================================================================
// Message handler
// ============================================================================

function handleMessage(msg: WSMessage, store: () => ReturnType<typeof useGameStore.getState>) {
  switch (msg.type) {
    case 'reset':
      store().reset();
      break;

    case 'status':
      store().setStatus(msg.status as any);
      break;

    case 'error':
      store().setError(msg.error as string | null);
      break;

    case 'begin-streaming':
      store().beginStreamingEntry();
      break;

    case 'text-chunk':
      store().appendToStreamingEntry(msg.text as string);
      break;

    case 'reasoning-chunk':
      store().appendReasoningToStreamingEntry(msg.text as string);
      break;

    case 'finalize':
      store().finalizeStreamingEntry();
      break;

    case 'entry':
      store().appendEntry(msg.entry as { role: 'generate' | 'receive' | 'system'; content: string });
      break;

    case 'restored': {
      // 恢复快照：清空当前 entries，加载 DB 中的历史
      store().reset();
      const entries = msg.entries as Array<{ role: string; content: string }>;
      if (entries) {
        for (const entry of entries) {
          store().appendEntry({
            role: entry.role as 'generate' | 'receive' | 'system',
            content: entry.content,
          });
        }
      }
      // 恢复输入状态
      if (msg.inputHint) store().setInputHint(msg.inputHint as string);
      if (msg.inputType === 'choice' && msg.choices) {
        store().setInputType('choice', msg.choices as string[]);
      }
      store().setStatus(msg.status as any);
      break;
    }

    case 'tool-call':
      store().addToolCall({ name: msg.name as string, args: msg.args as Record<string, unknown>, result: undefined });
      break;

    case 'pending-tool-call':
      store().addPendingToolCall({ name: msg.name as string, args: msg.args as Record<string, unknown>, result: undefined });
      break;

    case 'tool-result':
      break;

    case 'pending-tool-result':
      break;

    case 'input-hint':
      store().setInputHint(msg.hint as string | null);
      break;

    case 'input-type':
      store().setInputType(
        msg.inputType as 'freetext' | 'choice',
        msg.choices as string[] | null,
      );
      break;
  }
}
