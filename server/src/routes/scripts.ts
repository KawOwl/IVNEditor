/**
 * Script Routes — 剧本 CRUD API
 *
 * POST   /api/scripts          — 发布剧本
 * GET    /api/scripts/catalog   — 获取已发布剧本目录
 * GET    /api/scripts/:id       — 获取剧本详情（后端内部用，不暴露 manifest 给玩家）
 * DELETE /api/scripts/:id       — 删除剧本
 */

import { Elysia, t } from 'elysia';
import { scriptStore } from '../storage/script-store';

export const scriptRoutes = new Elysia({ prefix: '/api/scripts' })

  // Publish a script
  .post('/', ({ body }) => {
    const record = body as any;
    if (!record.id || !record.manifest) {
      return { error: 'Missing id or manifest' };
    }
    scriptStore.publish(record);
    return { ok: true, id: record.id };
  })

  // Get published catalog (lightweight, no manifest content)
  .get('/catalog', () => {
    return scriptStore.listPublished();
  })

  // Get script by ID (server-internal, for creating sessions)
  .get('/:id', ({ params }) => {
    const record = scriptStore.get(params.id);
    if (!record) {
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    }
    return record;
  })

  // Delete a script
  .delete('/:id', ({ params }) => {
    const deleted = scriptStore.delete(params.id);
    return { ok: deleted };
  });
