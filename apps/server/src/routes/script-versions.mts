/**
 * Script Version Routes — 剧本版本管理 HTTP 接口
 *
 * 这些是 v2.6 新增的 "版本感知" 接口，6.3 前端会开始使用。
 * 权限：只有剧本的作者能操作自己剧本的版本（按 scriptService.getOwnerId）。
 *
 *   POST   /api/scripts/:id/versions               — 创建新 draft 版本
 *   GET    /api/scripts/:id/versions               — 列出该剧本所有版本
 *   GET    /api/script-versions/:versionId         — 取单个版本详情（含 manifest）
 *   POST   /api/script-versions/:versionId/publish — 发布一个 draft 版本
 *   DELETE /api/script-versions/:versionId         — 删除 draft 版本
 *
 * 注意：URL 参数用 `:id` 而不是 `:scriptId`。原因是 Elysia / memoirist
 * router 不允许同一路径位置出现不同名字的参数——`/api/scripts/:id`（来自
 * scriptRoutes）已经占了 `:id` 这个 slot，新 routes 必须沿用同样的名字，
 * 否则启动时会抛 "different parameter name" 错误。
 */

import { Elysia } from 'elysia';
import type { ScriptManifest } from '@ivn/core/types';
import { scriptService } from '#internal/services/script-service';
import { scriptVersionService } from '#internal/services/script-version-service';
import { requireAdmin, isResponse } from '#internal/auth-identity';

/**
 * 校验某剧本存在（不再做 ownership 检查——当前所有 admin 都能操作所有
 * 剧本，由路由层 requireAdmin 把关）
 */
async function requireScriptExists(scriptId: string): Promise<true | Response> {
  const ownerId = await scriptService.getOwnerId(scriptId);
  if (!ownerId) {
    return new Response(JSON.stringify({ error: 'Script not found' }), { status: 404 });
  }
  return true;
}

// ============================================================================
// Routes mounted on /api/scripts/:id/versions
// ============================================================================

export const scriptVersionsForScriptRoutes = new Elysia({ prefix: '/api/scripts/:id/versions' })

  // POST — 创建新 draft 版本
  .post('/', async ({ params, body, request }) => {
    const auth = await requireAdmin(request);
    if (isResponse(auth)) return auth;

    const scriptId = params.id;  // URL :id 实际是 script id
    const exists = await requireScriptExists(scriptId);
    if (exists !== true) return exists;

    const input = body as Partial<{
      manifest: ScriptManifest;
      label: string;
      note: string;
    }>;
    if (!input.manifest) {
      return new Response(JSON.stringify({ error: 'Missing manifest' }), { status: 400 });
    }

    const result = await scriptVersionService.create({
      scriptId,
      manifest: input.manifest,
      label: input.label,
      note: input.note,
      status: 'draft',
    });

    return {
      versionId: result.version.id,
      versionNumber: result.version.versionNumber,
      created: result.created,
      status: result.version.status,
    };
  })

  // GET — 列出某剧本所有版本（summary，不含 manifest）
  .get('/', async ({ params, request }) => {
    const auth = await requireAdmin(request);
    if (isResponse(auth)) return auth;

    const scriptId = params.id;
    const exists = await requireScriptExists(scriptId);
    if (exists !== true) return exists;

    const versions = await scriptVersionService.listByScript(scriptId);
    return { versions };
  });

// ============================================================================
// Routes mounted on /api/script-versions/:versionId
// ============================================================================

export const scriptVersionRoutes = new Elysia({ prefix: '/api/script-versions' })

  // GET /:versionId — 取单个版本详情（含 manifest）
  .get('/:versionId', async ({ params, request }) => {
    const auth = await requireAdmin(request);
    if (isResponse(auth)) return auth;

    const version = await scriptVersionService.getById(params.versionId);
    if (!version) {
      return new Response(JSON.stringify({ error: 'Version not found' }), { status: 404 });
    }

    const exists = await requireScriptExists(version.scriptId);
    if (exists !== true) return exists;

    return version;
  })

  // POST /:versionId/publish — 发布一个 draft
  .post('/:versionId/publish', async ({ params, request }) => {
    const auth = await requireAdmin(request);
    if (isResponse(auth)) return auth;

    const version = await scriptVersionService.getById(params.versionId);
    if (!version) {
      return new Response(JSON.stringify({ error: 'Version not found' }), { status: 404 });
    }

    const exists = await requireScriptExists(version.scriptId);
    if (exists !== true) return exists;

    const ok = await scriptVersionService.publish(params.versionId);
    if (!ok) {
      return new Response(
        JSON.stringify({ error: 'Cannot publish: version is not in draft status' }),
        { status: 409 },
      );
    }
    return { ok: true };
  })

  // DELETE /:versionId — 删除 draft 版本
  .delete('/:versionId', async ({ params, request }) => {
    const auth = await requireAdmin(request);
    if (isResponse(auth)) return auth;

    const version = await scriptVersionService.getById(params.versionId);
    if (!version) {
      return new Response(JSON.stringify({ error: 'Version not found' }), { status: 404 });
    }

    const exists = await requireScriptExists(version.scriptId);
    if (exists !== true) return exists;

    const result = await scriptVersionService.deleteDraft(params.versionId);
    if (!result.ok) {
      const status = result.reason === 'not_found' ? 404 : 409;
      return new Response(
        JSON.stringify({ error: `Cannot delete: ${result.reason}` }),
        { status },
      );
    }
    return { ok: true };
  });
