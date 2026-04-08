/**
 * Playthrough Routes — 游玩记录 HTTP 接口
 *
 * 所有接口都要求 playerAuth。ownership 校验通过 service 层的 WHERE 子句强制。
 */

import { Elysia } from 'elysia';
import { playthroughService } from '../services/playthrough-service';
import { scriptStore } from '../storage/script-store';
import { requirePlayer, isResponse } from '../auth-identity';

export const playthroughRoutes = new Elysia({ prefix: '/api/playthroughs' })

  // GET / — 列出当前用户的游玩记录
  .get('/', async ({ query, request }) => {
    const id = await requirePlayer(request);
    if (isResponse(id)) return id;

    const { scriptId } = query as { scriptId?: string };
    const playthroughs = await playthroughService.list({
      userId: id.userId,
      scriptId,
    });

    // 附加 scriptTitle（从 scriptStore 读取）
    const withTitles = playthroughs.map((pt) => {
      const record = scriptStore.get(pt.scriptId);
      return { ...pt, scriptTitle: record?.manifest.title ?? pt.scriptId };
    });

    return { playthroughs: withTitles };
  })

  // POST / — 为当前用户创建新游玩
  .post('/', async ({ body, request }) => {
    const id = await requirePlayer(request);
    if (isResponse(id)) return id;

    const { scriptId, title } = body as { scriptId: string; title?: string };

    if (!scriptId) {
      return new Response(JSON.stringify({ error: 'Missing scriptId' }), { status: 400 });
    }

    const record = scriptStore.get(scriptId);
    if (!record) {
      return new Response(JSON.stringify({ error: 'Script not found' }), { status: 404 });
    }

    const chapterId = record.manifest.chapters[0]?.id ?? 'ch1';
    const result = await playthroughService.create({
      userId: id.userId,
      scriptId,
      chapterId,
      title,
    });
    return result;
  })

  // GET /:id — 游玩详情 + entries（分页），ownership 强制
  .get('/:id', async ({ params, query, request }) => {
    const id = await requirePlayer(request);
    if (isResponse(id)) return id;

    const limit = Number((query as any).limit) || 50;
    const offset = Number((query as any).offset) || 0;

    const detail = await playthroughService.getById(params.id, id.userId, limit, offset);
    if (!detail) {
      return new Response(JSON.stringify({ error: 'Playthrough not found' }), { status: 404 });
    }
    return detail;
  })

  // PATCH /:id — 更新（改标题/归档），ownership 强制
  .patch('/:id', async ({ params, body, request }) => {
    const id = await requirePlayer(request);
    if (isResponse(id)) return id;

    const { title, archived } = body as { title?: string; archived?: boolean };
    const updated = await playthroughService.update(params.id, id.userId, {
      title,
      archived,
    });
    if (!updated) {
      return new Response(JSON.stringify({ error: 'Playthrough not found' }), { status: 404 });
    }
    return { ok: true };
  })

  // DELETE /:id — 硬删除，ownership 强制
  .delete('/:id', async ({ params, request }) => {
    const id = await requirePlayer(request);
    if (isResponse(id)) return id;

    const deleted = await playthroughService.delete(params.id, id.userId);
    if (!deleted) {
      return new Response(JSON.stringify({ error: 'Playthrough not found' }), { status: 404 });
    }
    return { ok: true };
  });
