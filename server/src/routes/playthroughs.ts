/**
 * Playthrough Routes — 游玩记录 HTTP 接口
 *
 * 只负责 HTTP 协议处理（参数解析、状态码、响应格式），
 * 业务逻辑委托给 PlaythroughService。
 */

import { Elysia } from 'elysia';
import { playthroughService } from '../services/playthrough-service';
import { scriptStore } from '../storage/script-store';

export const playthroughRoutes = new Elysia({ prefix: '/api/playthroughs' })

  // GET / — 列出游玩记录
  .get('/', async ({ query }) => {
    const { scriptId, playerId } = query as { scriptId?: string; playerId?: string };
    const playthroughs = await playthroughService.list({ scriptId, playerId });

    // 附加 scriptTitle（从 scriptStore 读取）
    const withTitles = playthroughs.map((pt) => {
      const record = scriptStore.get(pt.scriptId);
      return { ...pt, scriptTitle: record?.manifest.title ?? pt.scriptId };
    });

    return { playthroughs: withTitles };
  })

  // POST / — 创建新游玩
  .post('/', async ({ body }) => {
    const { scriptId, playerId, title } = body as {
      scriptId: string;
      playerId?: string;
      title?: string;
    };

    if (!scriptId) {
      return new Response(JSON.stringify({ error: 'Missing scriptId' }), { status: 400 });
    }

    const record = scriptStore.get(scriptId);
    if (!record) {
      return new Response(JSON.stringify({ error: 'Script not found' }), { status: 404 });
    }

    const chapterId = record.manifest.chapters[0]?.id ?? 'ch1';
    const result = await playthroughService.create({ scriptId, chapterId, playerId, title });
    return result;
  })

  // GET /:id — 游玩详情 + entries（分页）
  .get('/:id', async ({ params, query }) => {
    const limit = Number((query as any).limit) || 50;
    const offset = Number((query as any).offset) || 0;

    const detail = await playthroughService.getById(params.id, limit, offset);
    if (!detail) {
      return new Response(JSON.stringify({ error: 'Playthrough not found' }), { status: 404 });
    }
    return detail;
  })

  // PATCH /:id — 更新（改标题/归档）
  .patch('/:id', async ({ params, body }) => {
    const { title, archived } = body as { title?: string; archived?: boolean };
    const updated = await playthroughService.update(params.id, { title, archived });
    if (!updated) {
      return new Response(JSON.stringify({ error: 'Playthrough not found' }), { status: 404 });
    }
    return { ok: true };
  })

  // DELETE /:id — 硬删除
  .delete('/:id', async ({ params }) => {
    const deleted = await playthroughService.delete(params.id);
    if (!deleted) {
      return new Response(JSON.stringify({ error: 'Playthrough not found' }), { status: 404 });
    }
    return { ok: true };
  });
