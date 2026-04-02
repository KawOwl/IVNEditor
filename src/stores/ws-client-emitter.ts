/**
 * WebSocket Client Emitter — 前端接收后端 WS 事件并写入 Zustand
 *
 * 与 server/src/ws-session-emitter.ts 对称：
 *   后端 GameSession → WebSocketSessionEmitter → WS → 本文件 → Zustand GameStore
 *
 * 消息类型与 ws-session-emitter.ts 中 emit() 的 type 参数一一对应。
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
  /** Tell backend to stop the session */
  stop(): void;
  /** Close the WebSocket connection */
  disconnect(): void;
}

// ============================================================================
// Create remote session
// ============================================================================

/**
 * Connect to the backend game session via WebSocket.
 *
 * Flow:
 *   1. POST /api/sessions { scriptId } → { sessionId }
 *   2. Open WS to /api/sessions/ws/:sessionId
 *   3. On WS messages: dispatch to Zustand store
 *
 * Returns a RemoteSession handle for sending commands.
 */
export async function createRemoteSession(
  baseUrl: string,
  scriptId: string,
): Promise<RemoteSession> {
  const store = () => useGameStore.getState();

  // 1. Create session on backend
  const res = await fetch(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scriptId }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(err.error ?? `Failed to create session: ${res.status}`);
  }

  const { sessionId } = await res.json() as { sessionId: string };

  // 2. Open WebSocket
  const wsProtocol = baseUrl.startsWith('https') ? 'wss' : 'ws';
  const wsHost = baseUrl.replace(/^https?:\/\//, '');
  const ws = new WebSocket(`${wsProtocol}://${wsHost}/api/sessions/ws/${sessionId}`);

  return new Promise<RemoteSession>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WebSocket connection timeout'));
    }, 10000);

    ws.onopen = () => {
      // Wait for 'connected' message before resolving
    };

    ws.onmessage = (event) => {
      try {
        const msg: WSMessage = JSON.parse(event.data);
        handleMessage(msg, store);

        // Resolve on initial connection confirmation
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
        store().setStatus('idle');
      }
    };

    const session: RemoteSession = {
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
// Message handler — maps WS events to Zustand actions
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

    case 'text-chunk':
      store().appendStreamingChunk(msg.text as string);
      break;

    case 'reasoning-chunk':
      store().appendReasoningChunk(msg.text as string);
      break;

    case 'finalize':
      store().finalizeStreaming();
      break;

    case 'entry':
      store().appendEntry(msg.entry as { role: 'generate' | 'receive' | 'system'; content: string });
      break;

    case 'tool-call':
      store().addToolCall({ name: msg.name as string, args: msg.args as Record<string, unknown>, result: undefined });
      break;

    case 'pending-tool-call':
      store().addPendingToolCall({ name: msg.name as string, args: msg.args as Record<string, unknown>, result: undefined });
      break;

    case 'tool-result':
      // Update the last matching tool call with its result
      break;

    case 'pending-tool-result':
      // Update the last matching pending tool call with its result
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

    // 'connected' is handled in createRemoteSession
    // Debug messages are not sent in player mode
  }
}
