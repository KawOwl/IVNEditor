/**
 * WebSocket Client Emitter — 前端接收后端 WS 事件并写入 Zustand
 *
 * 支持两种连接模式：
 *   - createRemoteSession: 新建游玩（POST /sessions → WS → start）
 *   - reconnectRemoteSession: 恢复游玩（POST /sessions/reconnect → WS → restore）
 */

import { useGameStore } from './game-store';

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
  /** Tell backend to start the game session */
  start(): void;
  /** Tell backend to restore from DB */
  restore(): void;
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
// ============================================================================

export async function createRemoteSession(
  baseUrl: string,
  scriptId: string,
): Promise<RemoteSession> {
  const store = () => useGameStore.getState();

  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scriptId }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error ?? `Failed to create session: ${res.status}`);
  }

  const { sessionId, playthroughId } = await res.json() as {
    sessionId: string;
    playthroughId: string;
    title: string;
  };

  // 存储 playthroughId 供重连用
  storePlaythroughId(scriptId, playthroughId);

  return connectWebSocket(baseUrl, sessionId, playthroughId, store);
}

// ============================================================================
// Reconnect to existing playthrough
// ============================================================================

export async function reconnectRemoteSession(
  baseUrl: string,
  playthroughId: string,
): Promise<RemoteSession> {
  const store = () => useGameStore.getState();

  const res = await fetch(`${baseUrl}/api/sessions/reconnect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playthroughId }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error ?? `Failed to reconnect: ${res.status}`);
  }

  const { sessionId } = await res.json() as {
    sessionId: string;
    playthroughId: string;
    source: 'memory' | 'database';
  };

  return connectWebSocket(baseUrl, sessionId, playthroughId, store);
}

// ============================================================================
// Shared WebSocket connection logic
// ============================================================================

function connectWebSocket(
  baseUrl: string,
  sessionId: string,
  playthroughId: string,
  store: () => ReturnType<typeof useGameStore.getState>,
): Promise<RemoteSession> {
  const wsProtocol = baseUrl.startsWith('https') ? 'wss' : 'ws';
  const wsHost = baseUrl.replace(/^https?:\/\//, '');
  const ws = new WebSocket(`${wsProtocol}://${wsHost}/api/sessions/ws/${sessionId}`);

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
      restore() {
        ws.send(JSON.stringify({ type: 'restore' }));
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
