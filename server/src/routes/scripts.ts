/**
 * Script Routes — 剧本 CRUD API
 *
 * v2.6 后：剧本不再直接存 manifest，而是通过 scripts + script_versions
 * 两张表管理。本路由保持 API 对外形状兼容（为了 6.3 前端迁移前不挂），
 * 内部改用 scriptService + scriptVersionService。
 *
 * 旧契约（保留兼容）：
 *   POST   /api/scripts          — "发布"剧本（接收完整 ScriptRecord）
 *   DELETE /api/scripts/:id      — 删除剧本
 *   GET    /api/scripts/catalog  — 已发布剧本目录
 *   GET    /api/scripts/:id      — 单个剧本公开信息
 *   GET    /api/scripts/:id/full — 完整 ScriptRecord（编辑器加载用）
 *
 * 新逻辑（内部）：
 *   POST /api/scripts 把 ScriptRecord 转成 scripts + script_versions：
 *     1. 先 upsert scripts 行（label/description）
 *     2. 创建一个新的 script_version，status='published'
 *     3. 之前的 published 版本会被 ScriptVersionService.create 自动转 archived
 *
 *   GET /api/scripts/catalog 调 scriptVersionService.listPublishedCatalog()
 *
 *   GET /api/scripts/:id 拿 "当前 published 版本"，用其 manifest 生成
 *   PublicScriptInfo；如果剧本没有 published 版本返回 404。
 *
 *   GET /api/scripts/:id/full 拿 "当前 published 版本"，拼回 legacy
 *   ScriptRecord 形状给编辑器（编辑器 6.3 会改用 /script-versions 路由）。
 */

import { Elysia } from 'elysia';
import type { ScriptManifest } from '../../../src/core/types';
import { scriptService } from '../services/script-service';
import { scriptVersionService } from '../services/script-version-service';
import { requireAdmin, requireAnyIdentity, isResponse } from '../auth-identity';

/** 剧本公开信息（不含 prompt segments，玩家可见） */
interface PublicScriptInfo {
  id: string;
  label: string;
  description?: string;
  coverImage?: string;
  author?: string;
  tags?: string[];
  chapterCount: number;
  firstChapterId: string | null;
  openingMessages?: string[];
}

/** legacy ScriptRecord 形状（编辑器加载用，6.3 后废弃） */
interface LegacyScriptRecord {
  id: string;
  label: string;
  description: string;
  createdAt: number;
  updatedAt: number;
  published: boolean;
  manifest: ScriptManifest;
}

function manifestToPublicInfo(scriptId: string, manifest: ScriptManifest): PublicScriptInfo {
  return {
    id: scriptId,
    label: manifest.label,
    description: manifest.description,
    coverImage: manifest.coverImage,
    author: manifest.author,
    tags: manifest.tags,
    chapterCount: manifest.chapters.length,
    firstChapterId: manifest.chapters[0]?.id ?? null,
    openingMessages: manifest.openingMessages,
  };
}

export const scriptRoutes = new Elysia({ prefix: '/api/scripts' })

  // ============================================================================
  // POST / — 创建剧本（admin only）
  // ============================================================================
  //
  // 接受两种 body 形状：
  //   1) 新 flow（6.3 起推荐）：{ id?, label, description? }
  //      只创建 scripts 行，不创建任何版本。
  //      后续 POST /api/scripts/:id/versions 创建 draft。
  //
  //   2) 旧 flow（legacy 发布路径，向后兼容）：{ id, label, manifest,
  //      description? }
  //      原子性地 upsert scripts + 创建 published 版本，保留旧编辑器的
  //      "一键发布" 路径。
  //
  // 权限模型：编辑器全功能保持 admin-only（符合原设计"剧本详情只有
  // admin 能看"），当前登录 admin 自动成为 authorUserId。
  .post('/', async ({ body, request }) => {
    const id = await requireAdmin(request);
    if (isResponse(id)) return id;

    const record = body as Partial<LegacyScriptRecord>;
    if (!record.label) {
      return new Response(
        JSON.stringify({ error: 'Missing label' }),
        { status: 400 },
      );
    }

    // 1. Upsert scripts 行
    const script = await scriptService.create({
      id: record.id,
      authorUserId: id.userId,
      label: record.label,
      description: record.description ?? record.manifest?.description,
    });

    // 2. 如果 body 带了 manifest，走 legacy 路径：创建 published 版本
    if (record.manifest) {
      const result = await scriptVersionService.create({
        scriptId: script.id,
        manifest: record.manifest,
        status: 'published',
      });
      return { ok: true, id: script.id, versionId: result.version.id, created: result.created };
    }

    // 3. 新 flow：只返回 scriptId，前端另行调用 /versions
    return { ok: true, id: script.id };
  })

  // ============================================================================
  // PATCH /:id — 更新剧本元数据（label/description）
  // ============================================================================
  //
  // Admin only + 作者 ownership 强制。只动 scripts 表，不创建新版本。
  .patch('/:id', async ({ params, body, request }) => {
    const id = await requireAdmin(request);
    if (isResponse(id)) return id;

    const patch = body as { label?: string; description?: string | null };
    const ok = await scriptService.update(params.id, id.userId, patch);
    if (!ok) {
      return new Response(
        JSON.stringify({ error: 'Script not found or not owned by you' }),
        { status: 404 },
      );
    }
    return { ok: true };
  })

  // ============================================================================
  // GET /catalog — 目录列表（任何已认证身份可读）
  // ============================================================================
  .get('/catalog', async ({ request }) => {
    const id = await requireAnyIdentity(request);
    if (isResponse(id)) return id;

    const catalog = await scriptVersionService.listPublishedCatalog();
    return catalog.map((entry) => ({
      id: entry.scriptId,
      label: entry.version.manifest.label ?? entry.scriptLabel,
      description: entry.version.manifest.description ?? entry.scriptDescription ?? undefined,
      tags: entry.version.manifest.tags,
      chapterCount: entry.version.manifest.chapters.length,
    }));
  })

  // ============================================================================
  // GET /:id — 单个剧本的公开信息（来自当前 published 版本）
  // ============================================================================
  .get('/:id', async ({ params, request }) => {
    const id = await requireAnyIdentity(request);
    if (isResponse(id)) return id;

    const version = await scriptVersionService.getCurrentPublished(params.id);
    if (!version) {
      return new Response(JSON.stringify({ error: 'Script not found or not published' }), { status: 404 });
    }
    return manifestToPublicInfo(params.id, version.manifest);
  })

  // ============================================================================
  // GET /:id/full — 完整 ScriptRecord（编辑器加载用，legacy 兼容）
  // ============================================================================
  //
  // 6.3 编辑器会优先走 GET /api/scripts/:id/versions + GET
  // /api/script-versions/:versionId；此端点保留给未迁移的代码路径。
  // Admin only。
  .get('/:id/full', async ({ params, request }) => {
    const _id = await requireAdmin(request);
    if (isResponse(_id)) return _id;

    const script = await scriptService.getById(params.id);
    if (!script) {
      return new Response(JSON.stringify({ error: 'Script not found' }), { status: 404 });
    }

    // 取当前 published 版本的 manifest；如果没有 published 版本，
    // 取最新版本（让编辑器至少能加载到草稿）
    let version = await scriptVersionService.getCurrentPublished(params.id);
    if (!version) {
      const all = await scriptVersionService.listByScript(params.id);
      if (all.length === 0) {
        return new Response(JSON.stringify({ error: 'Script has no versions' }), { status: 404 });
      }
      const latestId = all[0]!.id;
      version = await scriptVersionService.getById(latestId);
    }
    if (!version) {
      return new Response(JSON.stringify({ error: 'Version not found' }), { status: 404 });
    }

    const legacyRecord: LegacyScriptRecord = {
      id: script.id,
      label: script.label,
      description: script.description ?? '',
      createdAt: script.createdAt.getTime(),
      updatedAt: script.updatedAt.getTime(),
      published: version.status === 'published',
      manifest: version.manifest,
    };
    return legacyRecord;
  })

  // ============================================================================
  // DELETE /:id — 删除剧本（级联删 script_versions 和相关 playthroughs）
  // ============================================================================
  //
  // Admin only + 作者 ownership 强制。
  .delete('/:id', async ({ params, request }) => {
    const id = await requireAdmin(request);
    if (isResponse(id)) return id;

    const deleted = await scriptService.delete(params.id, id.userId);
    if (!deleted) {
      return new Response(
        JSON.stringify({ error: 'Script not found or not owned by you' }),
        { status: 404 },
      );
    }
    return { ok: true };
  })

  // ============================================================================
  // GET /mine — 列出当前 admin 作为作者的所有剧本（编剧工作区用）
  // ============================================================================
  //
  // 6.3 编辑器会用这个代替本地 IndexedDB 列表。返回 scripts 表行 +
  // 每个剧本的最新版本状态（draft/published/archived）方便前端展示。
  .get('/mine', async ({ request }) => {
    const id = await requireAdmin(request);
    if (isResponse(id)) return id;

    const scripts = await scriptService.listByAuthor(id.userId);
    // 为每个 script 附带最新版本信息
    const withVersions = await Promise.all(
      scripts.map(async (s) => {
        const versions = await scriptVersionService.listByScript(s.id);
        const published = versions.find((v) => v.status === 'published');
        const latestDraft = versions.find((v) => v.status === 'draft');
        return {
          id: s.id,
          label: s.label,
          description: s.description,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          versionCount: versions.length,
          hasPublished: !!published,
          publishedVersionId: published?.id ?? null,
          latestDraftVersionId: latestDraft?.id ?? null,
        };
      }),
    );
    return { scripts: withVersions };
  });
