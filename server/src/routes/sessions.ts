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
import { SessionManager } from '../session-manager';
import { playthroughService } from '../services/playthrough-service';
import { scriptVersionService } from '../services/script-version-service';
import { llmConfigService } from '../services/llm-config-service';
import { resolvePlayerSession } from '../auth-identity';
import type { LLMConfig } from '../../../src/core/llm-client';

const sessionManager = new SessionManager();

/** 从 Elysia WS 对象里读取 query 参数（handler 间 ws 引用可能变化，每次都重新读） */
function getWsQuery(ws: unknown): { sessionId?: string; playthroughId?: string } {
  return ((ws as any)?.data?.query ?? {}) as { sessionId?: string; playthroughId?: string };
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
      const { sessionId: authSession, playthroughId } = getWsQuery(ws);

      if (!authSession || !playthroughId) {
        ws.send(JSON.stringify({ type: 'error', error: 'Missing sessionId or playthroughId' }));
        ws.close();
        return;
      }

      console.log(`[WS] open: pt=${playthroughId.substring(0, 8)}`);

      // 1. 校验 auth
      const identity = await resolvePlayerSession(authSession);
      if (!identity) {
        ws.send(JSON.stringify({ type: 'error', error: 'Invalid or expired session' }));
        ws.close();
        return;
      }

      // 2. 查 playthrough + ownership 校验（service 层 WHERE 强制）
      const detail = await playthroughService.getById(playthroughId, identity.userId, 50);
      if (!detail) {
        ws.send(JSON.stringify({ type: 'error', error: 'Playthrough not found' }));
        ws.close();
        return;
      }

      // 3. 从 script_versions 表拿 manifest 快照
      const version = await scriptVersionService.getById(detail.scriptVersionId);
      if (!version) {
        ws.send(JSON.stringify({ type: 'error', error: 'Script version not found' }));
        ws.close();
        return;
      }

      // 4. 按 playthrough 固化的 llmConfigId 拉 LLM 配置（v2.7）
      const llmConfigRow = await llmConfigService.getById(detail.llmConfigId);
      if (!llmConfigRow) {
        ws.send(JSON.stringify({ type: 'error', error: 'LLM config not found for this playthrough' }));
        ws.close();
        return;
      }
      const llmConfig: LLMConfig = {
        provider: llmConfigRow.provider,
        baseURL: llmConfigRow.baseUrl,
        apiKey: llmConfigRow.apiKey,
        model: llmConfigRow.model,
        name: llmConfigRow.name,
        maxOutputTokens: llmConfigRow.maxOutputTokens,
        thinkingEnabled: llmConfigRow.thinkingEnabled,
        reasoningEffort: llmConfigRow.reasoningEffort as 'high' | 'max' | null,
      };

      // 5. getOrCreate wrapper（按 playthroughId 索引）
      // 把 playthrough 的 kind 透传给 wrapper，让 Langfuse trace 能据此区分
      // production / playtest（编辑器试玩）
      const wrapper = sessionManager.getOrCreate(
        playthroughId,
        version.manifest,
        version.id,
        identity.userId,
        detail.kind,
        llmConfig,
      );
      wrapper.attachWebSocket(ws);

      // 5. 推送 connected
      ws.send(JSON.stringify({
        type: 'connected',
        playthroughId,
      }));

      // 6. 决定 start 还是 restore
      const isNewPlaythrough = detail.turn === 0 && detail.totalEntries === 0;
      if (!isNewPlaythrough) {
        // 推送快照给客户端（恢复 UI）
        ws.send(JSON.stringify({
          type: 'restored',
          playthroughId,
          status: detail.status,
          turn: detail.turn,
          stateVars: detail.stateVars,
          inputHint: detail.inputHint,
          inputType: detail.inputType,
          choices: detail.choices,
          entries: detail.entries,
          totalEntries: detail.totalEntries,
          hasMore: detail.hasMore,
          // M3：VN 当前场景快照。client ws-client-emitter 'restored' handler
          // 用它给每条合成的 Sentence 设 sceneRef，并 setCurrentScene 驱动
          // VN stage 渲染背景/立绘。不传 → client fallback 到空场景（bug）。
          currentScene: detail.currentScene,
        }));

        // 恢复 GameSession 的内存状态
        wrapper.restore({
          stateVars: detail.stateVars ?? {},
          turn: detail.turn,
          // memorySnapshot 是 opaque JSON，直接透传给 GameSession → Memory.restore
          memorySnapshot: detail.memorySnapshot,
          status: detail.status,
          inputHint: detail.inputHint,
          inputType: detail.inputType,
          choices: detail.choices,
          // M3: VN 场景快照（老 playthrough 无此字段，传 null 走 defaultScene fallback）
          currentScene: detail.currentScene ?? null,
        });
      }
      // 新游戏：等客户端主动发 'start'
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
