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
import { useRawStreamingStore } from './raw-streaming-store';
import { ensureSessionId, fetchWithAuth } from './player-session-store';
import { NarrativeParser } from '../core/narrative-parser';
import type { Sentence, SceneState } from '../core/types';

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
        handleMessage(msg, store, baseUrl);

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

// ============================================================================
// Message handler
// ============================================================================

function handleMessage(
  msg: WSMessage,
  store: () => ReturnType<typeof useGameStore.getState>,
  baseUrl: string,
) {
  switch (msg.type) {
    case 'reset': {
      // M1 Step 1.3：不能做全量 reset——PlayPanel 在 WS 连接前已经
      // seedOpeningSentences() 了，全量 reset 会把开场 narration 清掉。
      //
      // 全量 reset 的职责回到 PlayPage handleBack / handleSelect /
      // PlayPanel handleReset，由"玩家主动切换上下文"触发。服务端启动时
      // 发来的这条 'reset' 只清掉和服务端 narrative 流相关的 UI 态即可。
      const s = store();
      s.setStatus('idle');
      s.setError(null);
      s.setInputHint(null);
      s.setInputType('freetext', null);
      // 保留：parsedSentences / currentScene / visibleSentenceIndex
      //      （客户端 seedOpeningSentences 的产物）
      // 保留：entries / streamingEntryId（Step 1.7 会整批删）
      break;
    }

    case 'status':
      store().setStatus(msg.status as any);
      break;

    case 'error':
      store().setError(msg.error as string | null);
      break;

    case 'begin-streaming':
      // M1 Step 1.7：不再写 game-store.entries；只给 raw-streaming tab 清场
      useRawStreamingStore.getState().beginNew();
      break;

    case 'text-chunk':
      // 写到 raw-streaming 小仓库（给 EditorDebugPanel "Raw Streaming" tab 订阅）
      useRawStreamingStore.getState().append(msg.text as string);
      break;

    case 'reasoning-chunk':
      useRawStreamingStore.getState().appendReasoning(msg.text as string);
      break;

    case 'finalize':
      // VN UI 下不需要任何动作；Sentence 流已经由 parser 在 server 端产出并通过 'sentence' 事件送来了
      break;

    case 'entry':
      // 老协议：服务端直接推"一整条"，VN UI 下无视
      break;

    case 'restored': {
      // 恢复快照：清空前端 VN 状态，把 msg.entries（persisted 叙事原文）
      // 在客户端用 NarrativeParser 回放成 Sentence[]。不依赖服务端再推 sentence 事件。
      //
      // 注：sceneRef 能拿到的最好信息是 msg.currentScene（最后一帧），用它兜底；
      // 未来如果需要 per-turn 精确 sceneRef，可以把 scene 状态随 entries 一起持久化。
      //
      // Bug C 修复（2026-04-24）：服务端 'restored' 消息只带首 50 条（playthroughService.getById
      // 的 entriesLimit 默认值），超过 50 条的长 playthrough 客户端只能看到开头一小截，
      // backlog 翻页后面的内容都是空的。修复：msg.hasMore=true 时用 HTTP GET
      // /api/playthroughs/:id/entries 分页继续拉，直到全部加载完，再 setVisibleSentenceIndex
      // 到末尾。
      store().reset();

      type EntryRow = {
        role: string;
        /** migration 0010：'narrative' | 'signal_input' | 'player_input'（老数据默认 'narrative'） */
        kind?: string;
        content: string;
        /** migration 0010：按 kind 自描述的结构化载荷 */
        payload?: Record<string, unknown> | null;
        orderIdx?: number;
      };
      const initialEntries = (msg.entries ?? []) as EntryRow[];
      const sceneRef: SceneState =
        (msg.currentScene as SceneState | null) ?? { background: null, sprites: [] };

      // 把 entry → Sentence[] 的回放逻辑抽成闭包，initial + fetchMore 共用一份
      // globalIndex / turnNumber 计数，保证分页前后 Sentence.index / turnNumber 连续。
      const replayState = { globalIndex: 0, turnNumber: 0 };
      const replayEntries = (entries: EntryRow[]) => {
        for (const entry of entries) {
          // migration 0010: signal_input 事件（hint + choices）
          if (entry.kind === 'signal_input') {
            const choices = Array.isArray((entry.payload as { choices?: unknown } | null)?.choices)
              ? ((entry.payload as { choices?: string[] }).choices as string[])
              : [];
            const s: Sentence = {
              kind: 'signal_input',
              hint: entry.content,
              choices,
              sceneRef,
              turnNumber: replayState.turnNumber,
              index: replayState.globalIndex++,
            };
            store().appendSentence(s);
            continue;
          }
          if (entry.role === 'receive') {
            // 玩家的回复气泡 —— 合成一条 player_input Sentence 让 backlog 能重现
            // migration 0010: payload.selectedIndex 让 backlog 知道"选的是第几个选项"
            const selectedIndex = typeof (entry.payload as { selectedIndex?: unknown } | null)?.selectedIndex === 'number'
              ? ((entry.payload as { selectedIndex: number }).selectedIndex)
              : undefined;
            const s: Sentence = {
              kind: 'player_input',
              text: entry.content,
              ...(selectedIndex !== undefined ? { selectedIndex } : {}),
              sceneRef,
              turnNumber: replayState.turnNumber,
              index: replayState.globalIndex++,
            };
            store().appendSentence(s);
            continue;
          }
          if (entry.role !== 'generate') continue;
          replayState.turnNumber++;
          const parser = new NarrativeParser({
            onNarrationChunk: (text) => {
              const s: Sentence = {
                kind: 'narration',
                text,
                sceneRef,
                turnNumber: replayState.turnNumber,
                index: replayState.globalIndex++,
              };
              store().appendSentence(s);
            },
            onDialogueEnd: (pf, fullText, truncated) => {
              const base = {
                kind: 'dialogue' as const,
                text: fullText,
                pf,
                sceneRef,
                turnNumber: replayState.turnNumber,
                index: replayState.globalIndex++,
              };
              const s: Sentence =
                truncated !== undefined ? { ...base, truncated } : base;
              store().appendSentence(s);
            },
          });
          parser.push(entry.content);
          parser.finalize();
        }
      };

      replayEntries(initialEntries);

      // 应用最后一帧场景（change_scene 事件不会在 restore 流里重放）
      store().setCurrentScene(sceneRef);

      // 恢复输入状态
      if (msg.inputHint) store().setInputHint(msg.inputHint as string);
      if (msg.inputType === 'choice' && msg.choices) {
        store().setInputType('choice', msg.choices as string[]);
      } else {
        store().setInputType('freetext', null);
      }
      store().setStatus(msg.status as any);

      // fetchMore 分页拉 —— fire-and-forget。每页拉完就 append；全部拉完再
      // setVisibleSentenceIndex 到最后一条。如果 hasMore=false（或老服务端
      // 没给这个字段），直接定位末尾。
      const hasMore = Boolean(msg.hasMore);
      const playthroughIdForFetch =
        typeof msg.playthroughId === 'string' ? msg.playthroughId : null;

      const finalizeCursor = () => {
        const total = store().parsedSentences.length;
        if (total > 0) store().setVisibleSentenceIndex(total - 1);
      };

      if (!hasMore || !playthroughIdForFetch) {
        finalizeCursor();
      } else {
        const PAGE_SIZE = 200;
        // 硬上限：200 × 50 = 10000 条。超长 playthrough 也能扛，同时防 API 死循环。
        const MAX_PAGES = 50;

        const runFetchMore = async () => {
          let offset = initialEntries.length;
          for (let page = 0; page < MAX_PAGES; page++) {
            let res: Response;
            try {
              res = await fetchWithAuth(
                `${baseUrl}/api/playthroughs/${encodeURIComponent(playthroughIdForFetch)}/entries?offset=${offset}&limit=${PAGE_SIZE}`,
              );
            } catch (err) {
              console.error('[restored] fetchMore network error:', err);
              break;
            }
            if (!res.ok) {
              console.error('[restored] fetchMore HTTP', res.status);
              break;
            }
            let data: { entries: EntryRow[]; hasMore: boolean; totalEntries: number };
            try {
              data = await res.json();
            } catch (err) {
              console.error('[restored] fetchMore parse error:', err);
              break;
            }
            if (data.entries.length === 0) break;
            replayEntries(data.entries);
            offset += data.entries.length;
            if (!data.hasMore) break;
          }
          finalizeCursor();
        };

        void runFetchMore();
      }
      break;
    }

    case 'tool-call':
      store().addToolCall({ name: msg.name as string, args: msg.args as Record<string, unknown>, result: undefined });
      break;

    case 'pending-tool-call':
      // M1 Step 1.7：pending 机制是给老 entries 用的（附加在 finalize 的 entry 上），
      // VN UI 不需要。服务端仍会发这个事件，只是这里不处理。
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

    // --- Debug messages (only sent in playtest mode) ---
    case 'stage-pending-debug':
      // M1 Step 1.7：stagePendingDebug 下线（也是挂在 entries finalize 上的）
      break;

    case 'update-debug':
      store().updateDebug(msg as any);
      break;

    // --- VN Narrative & Scene (M3) ---
    case 'sentence':
      store().appendSentence(msg.sentence as import('./game-store').Sentence);
      break;

    case 'scene-change':
      store().setCurrentScene(
        msg.scene as import('./game-store').SceneState,
        msg.transition as 'fade' | 'cut' | 'dissolve' | undefined,
      );
      break;
  }
}
