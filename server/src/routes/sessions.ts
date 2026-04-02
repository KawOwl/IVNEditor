/**
 * Session Routes — 游玩会话管理
 *
 * POST /api/sessions           — 创建会话（返回 sessionId）
 * WS   /api/sessions/:id/ws    — WebSocket 连接（引擎推流 + 玩家输入）
 */

import { Elysia } from 'elysia';
import { scriptStore } from '../storage/script-store';
import { SessionManager } from '../session-manager';

const sessionManager = new SessionManager();

export const sessionRoutes = new Elysia({ prefix: '/api/sessions' })

  // Create a new session
  .post('/', ({ body }) => {
    const { scriptId } = body as { scriptId: string };
    if (!scriptId) {
      return new Response(JSON.stringify({ error: 'Missing scriptId' }), { status: 400 });
    }

    const record = scriptStore.get(scriptId);
    if (!record) {
      return new Response(JSON.stringify({ error: 'Script not found' }), { status: 404 });
    }

    const sessionId = crypto.randomUUID();
    sessionManager.create(sessionId, record.manifest);
    return { sessionId };
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
      ws.send(JSON.stringify({ type: 'connected', sessionId }));
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
      sessionManager.destroy(sessionId);
    },
  });
