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
import { scriptStore } from '../storage/script-store';
import { SessionManager } from '../session-manager';
import { playthroughService } from '../services/playthrough-service';
import { resolvePlayerSession } from '../auth-identity';

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

      // 3. 查 script manifest
      // TODO(6.2): scriptVersionId 现在存的是 scriptStore 的 key，6.2 后改为从
      // script_versions 表拿 manifest 快照
      const record = scriptStore.get(detail.scriptVersionId);
      if (!record) {
        ws.send(JSON.stringify({ type: 'error', error: 'Script not found' }));
        ws.close();
        return;
      }

      // 4. getOrCreate wrapper（按 playthroughId 索引）
      const wrapper = sessionManager.getOrCreate(playthroughId, record.manifest, identity.userId);
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
        }));

        // 恢复 GameSession 的内存状态
        wrapper.restore({
          stateVars: detail.stateVars ?? {},
          turn: detail.turn,
          memoryEntries: detail.memoryEntries ?? [],
          memorySummaries: detail.memorySummaries ?? [],
          status: detail.status,
          inputHint: detail.inputHint,
          inputType: detail.inputType,
          choices: detail.choices,
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
            wrapper.submitInput(data.text);
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
