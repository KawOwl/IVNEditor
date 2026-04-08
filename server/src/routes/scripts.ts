/**
 * Script Routes — 剧本 CRUD API
 *
 * 权限分级：
 *   POST   /api/scripts          — 发布剧本（admin only）
 *   DELETE /api/scripts/:id      — 删除剧本（admin only）
 *   GET    /api/scripts/catalog  — 剧本目录列表（所有已认证身份可读）
 *   GET    /api/scripts/:id      — 公开信息（player 可读，不含 prompt segments）
 *   GET    /api/scripts/:id/full — 完整 manifest（admin only，编辑器用）
 */

import { Elysia } from 'elysia';
import { scriptStore } from '../storage/script-store';
import { requireAdmin, requireAnyIdentity, isResponse } from '../auth-identity';

/** 剧本公开信息（不含 prompt segments，玩家可见） */
interface PublicScriptInfo {
  id: string;
  label: string;
  description?: string;
  coverImage?: string;
  author?: string;
  tags?: string[];
  version: string;
  chapterCount: number;
  firstChapterId: string | null;
  openingMessages?: string[];
}

function toPublicScriptInfo(id: string): PublicScriptInfo | null {
  const record = scriptStore.get(id);
  if (!record) return null;
  const manifest = record.manifest;
  return {
    id: record.id,
    label: manifest.label ?? record.label,
    description: manifest.description ?? record.description,
    coverImage: manifest.coverImage,
    author: manifest.author,
    tags: manifest.tags,
    version: manifest.version,
    chapterCount: manifest.chapters.length,
    firstChapterId: manifest.chapters[0]?.id ?? null,
    openingMessages: manifest.openingMessages,
  };
}

export const scriptRoutes = new Elysia({ prefix: '/api/scripts' })

  // ============================================================================
  // POST / — 发布剧本（admin only）
  // ============================================================================
  .post('/', async ({ body, request }) => {
    const id = await requireAdmin(request);
    if (isResponse(id)) return id;

    const record = body as any;
    if (!record.id || !record.manifest) {
      return new Response(JSON.stringify({ error: 'Missing id or manifest' }), { status: 400 });
    }
    scriptStore.publish(record);
    return { ok: true, id: record.id };
  })

  // ============================================================================
  // GET /catalog — 目录列表（任何已认证身份可读）
  // ============================================================================
  .get('/catalog', async ({ request }) => {
    const id = await requireAnyIdentity(request);
    if (isResponse(id)) return id;

    return scriptStore.listPublished();
  })

  // ============================================================================
  // GET /:id — 公开信息（player 和 admin 都可以读，但内容是脱敏的）
  // ============================================================================
  .get('/:id', async ({ params, request }) => {
    const id = await requireAnyIdentity(request);
    if (isResponse(id)) return id;

    const info = toPublicScriptInfo(params.id);
    if (!info) {
      return new Response(JSON.stringify({ error: 'Script not found' }), { status: 404 });
    }
    return info;
  })

  // ============================================================================
  // GET /:id/full — 完整 manifest（admin only）
  // ============================================================================
  .get('/:id/full', async ({ params, request }) => {
    const id = await requireAdmin(request);
    if (isResponse(id)) return id;

    const record = scriptStore.get(params.id);
    if (!record) {
      return new Response(JSON.stringify({ error: 'Script not found' }), { status: 404 });
    }
    return record;
  })

  // ============================================================================
  // DELETE /:id — 删除（admin only）
  // ============================================================================
  .delete('/:id', async ({ params, request }) => {
    const id = await requireAdmin(request);
    if (isResponse(id)) return id;

    const deleted = scriptStore.delete(params.id);
    return { ok: deleted };
  });
