/**
 * Session Routes — 游玩会话管理 + WS 重连
 *
 * POST /api/sessions                   — 创建新会话
 * POST /api/sessions/reconnect         — 重连到已有 playthrough
 * WS   /api/sessions/:id/ws            — WebSocket 连接
 */

import { Elysia } from 'elysia';
import { scriptStore } from '../storage/script-store';
import { SessionManager } from '../session-manager';
import { playthroughService } from '../services/playthrough-service';

const sessionManager = new SessionManager();

export const sessionRoutes = new Elysia({ prefix: '/api/sessions' })

  // ============================================================================
  // POST / — 创建新会话（新游玩）
  // ============================================================================

  .post('/', async ({ body }) => {
    const { scriptId, playerId } = body as { scriptId: string; playerId?: string };
    if (!scriptId) {
      return new Response(JSON.stringify({ error: 'Missing scriptId' }), { status: 400 });
    }

    const record = scriptStore.get(scriptId);
    if (!record) {
      return new Response(JSON.stringify({ error: 'Script not found' }), { status: 404 });
    }

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

  // ============================================================================
  // POST /reconnect — 重连到已有 playthrough
  // ============================================================================

  .post('/reconnect', async ({ body }) => {
    const { playthroughId } = body as { playthroughId: string };
    if (!playthroughId) {
      return new Response(JSON.stringify({ error: 'Missing playthroughId' }), { status: 400 });
    }

    // 检查内存中是否有活跃 session
    const existing = sessionManager.getByPlaythroughId(playthroughId);
    if (existing) {
      return { sessionId: existing.sessionId, playthroughId, source: 'memory' };
    }

    // 从 DB 加载 playthrough
    const detail = await playthroughService.getById(playthroughId, 0);
    if (!detail) {
      return new Response(JSON.stringify({ error: 'Playthrough not found' }), { status: 404 });
    }

    // 找到对应的 script manifest
    const record = scriptStore.get(detail.scriptId);
    if (!record) {
      return new Response(JSON.stringify({ error: 'Script not found' }), { status: 404 });
    }

    // 创建新 session，标记为需要恢复
    const sessionId = crypto.randomUUID();
    sessionManager.create(sessionId, record.manifest, playthroughId);

    return { sessionId, playthroughId, source: 'database' };
  })

  // ============================================================================
  // WS — WebSocket 连接
  // ============================================================================

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

          case 'restore': {
            // 客户端请求从 DB 恢复
            const ptId = session.getPlaythroughId();
            if (!ptId) {
              ws.send(JSON.stringify({ type: 'error', message: 'No playthroughId' }));
              break;
            }

            // 异步加载 DB 状态并恢复
            (async () => {
              try {
                const detail = await playthroughService.getById(ptId, 50);
                if (!detail) {
                  ws.send(JSON.stringify({ type: 'error', message: 'Playthrough not found in DB' }));
                  return;
                }

                // 推送状态快照给客户端（恢复 UI）
                ws.send(JSON.stringify({
                  type: 'restored',
                  playthroughId: ptId,
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

                // 恢复 GameSession（从 DB 快照）
                session.restore({
                  stateVars: detail.stateVars ?? {},
                  turn: detail.turn,
                  memoryEntries: detail.memoryEntries ?? [],
                  memorySummaries: detail.memorySummaries ?? [],
                  status: detail.status,
                  inputHint: detail.inputHint,
                  inputType: detail.inputType,
                  choices: detail.choices,
                });
              } catch (err) {
                ws.send(JSON.stringify({ type: 'error', message: `Restore failed: ${err}` }));
              }
            })();
            break;
          }

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
      // 断线：不立即销毁，启动 TTL（10 分钟内重连可恢复）
      sessionManager.detach(sessionId);
    },
  });
