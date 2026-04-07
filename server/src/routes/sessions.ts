/**
 * Session Routes — 游玩会话管理
 *
 * POST /api/sessions           — 创建会话（创建 playthrough + sessionId）
 * WS   /api/sessions/:id/ws    — WebSocket 连接（引擎推流 + 玩家输入）
 */

import { Elysia } from 'elysia';
import { scriptStore } from '../storage/script-store';
import { SessionManager } from '../session-manager';
import { playthroughService } from '../services/playthrough-service';

const sessionManager = new SessionManager();

export const sessionRoutes = new Elysia({ prefix: '/api/sessions' })

  // Create a new session (with playthrough persistence)
  .post('/', async ({ body }) => {
    const { scriptId, playerId } = body as { scriptId: string; playerId?: string };
    if (!scriptId) {
      return new Response(JSON.stringify({ error: 'Missing scriptId' }), { status: 400 });
    }

    const record = scriptStore.get(scriptId);
    if (!record) {
      return new Response(JSON.stringify({ error: 'Script not found' }), { status: 404 });
    }

    // 创建持久化的 playthrough 记录
    const chapterId = record.manifest.chapters[0]?.id ?? 'ch1';
    const playthrough = await playthroughService.create({
      scriptId,
      chapterId,
      playerId,
    });

    const sessionId = crypto.randomUUID();
    sessionManager.create(sessionId, record.manifest, playthrough.id);
    return { sessionId, playthroughId: playthrough.id, title: playthrough.title };
  })

  // WebSocket for game session streaming
  .ws('/ws/:id', {
    open(ws) {
      const sessionId = (ws.data as any).params.id;
      const session = sessionManager.get(sessionId);
      if (!session) {
        ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
        ws.close();
        return;
      }
      session.attachWebSocket(ws);
      ws.send(JSON.stringify({
        type: 'connected',
        sessionId,
        playthroughId: session.getPlaythroughId(),
      }));
    },

    message(ws, message) {
      const sessionId = (ws.data as any).params.id;
      const session = sessionManager.get(sessionId);
      if (!session) return;

      try {
        const data = typeof message === 'string' ? JSON.parse(message) : message;

        switch (data.type) {
          case 'start':
            session.start();
            break;
          case 'input':
            session.submitInput(data.text);
            break;
          case 'stop':
            session.stop();
            break;
        }
      } catch (err) {
        ws.send(JSON.stringify({ type: 'error', message: String(err) }));
      }
    },

    close(ws) {
      const sessionId = (ws.data as any).params.id;
      // 不立即销毁——保留 session 在内存中供重连（5.5 实现 TTL）
      // 当前先保持原行为：立即销毁
      sessionManager.destroy(sessionId);
    },
  });
