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
import { handleSessionMessage, type WSMessage } from './ws-message-handlers';

// ============================================================================
// Types
// ============================================================================

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
  /**
   * v2.7：指定本次 playthrough 使用的 LLM 配置 id（可选）。
   *
   * 编辑器试玩时前端从 localStorage 读 admin 的偏好 dropdown 值传过来，
   * 玩家侧从 PublicScriptInfo.productionLlmConfigId 读然后透传。
   *
   * 为空时后端会按 fallback 链选（见 server routes/playthroughs.ts POST）：
   *   script.production_llm_config_id → first llm_config by created_at。
   */
  llmConfigId?: string | null;
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
  const base = isVersionTarget
    ? { scriptVersionId: target.scriptVersionId, kind: options.kind ?? 'playtest' }
    : { scriptId: target, kind: options.kind ?? 'production' };
  const body = options.llmConfigId
    ? { ...base, llmConfigId: options.llmConfigId }
    : base;

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

  // 生产 build 用相对路径（getBackendUrl() 返回 ''），WS 需要 fallback 到页面同源
  // 否则 `ws:///api/...` 三斜杠空 host，浏览器直接 SyntaxError
  let wsProtocol: string;
  let wsHost: string;
  if (baseUrl) {
    wsProtocol = baseUrl.startsWith('https') ? 'wss' : 'ws';
    wsHost = baseUrl.replace(/^https?:\/\//, '');
  } else {
    wsProtocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    wsHost = window.location.host;
  }
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
        handleSessionMessage(msg, store, baseUrl);

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
        // M1 Step 1.7：finalizeStreamingEntry 已下线，这里只清输入和 status
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
