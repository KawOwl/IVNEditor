/**
 * Script Routes — 剧本 CRUD API
 *
 * POST   /api/scripts          — 发布剧本（需管理员）
 * GET    /api/scripts/catalog   — 获取已发布剧本目录（公开）
 * GET    /api/scripts/:id       — 获取剧本详情（公开，用于创建会话）
 * DELETE /api/scripts/:id       — 删除/下架剧本（需管理员）
 */

import { Elysia } from 'elysia';
import { scriptStore } from '../storage/script-store';
import { extractAdmin } from '../auth';

export const scriptRoutes = new Elysia({ prefix: '/api/scripts' })

  // Publish a script (admin only)
  .post('/', async ({ body, request }) => {
    const admin = await extractAdmin(request);
    if (!admin) {
      return new Response(JSON.stringify({ error: '需要管理员权限' }), { status: 403 });
    }

    const record = body as any;
    if (!record.id || !record.manifest) {
      return { error: 'Missing id or manifest' };
    }
    scriptStore.publish(record);
    return { ok: true, id: record.id };
  })

  // Get published catalog (public)
  .get('/catalog', () => {
    return scriptStore.listPublished();
  })

  // Get script by ID (public, for creating sessions)
  .get('/:id', ({ params }) => {
    const record = scriptStore.get(params.id);
    if (!record) {
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    }
    return record;
  })

  // Delete a script (admin only)
  .delete('/:id', async ({ params, request }) => {
    const admin = await extractAdmin(request);
    if (!admin) {
      return new Response(JSON.stringify({ error: '需要管理员权限' }), { status: 403 });
    }
    const deleted = scriptStore.delete(params.id);
    return { ok: deleted };
  });
