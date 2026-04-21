/**
 * Asset Routes — 资产上传 / 读取 / 删除（M4）
 *
 * 路由：
 *   POST   /api/scripts/:id/assets       — 上传一个资产（admin + script 所有者）
 *                                          multipart/form-data:
 *                                            file = <binary>
 *                                            kind = 'background' | 'sprite'（可选，默认 sprite）
 *                                          return 201 { id, storageKey, assetUrl, kind, contentType, sizeBytes }
 *
 *   GET    /api/scripts/:id/assets       — 列出某 script 的所有资产（admin + 所有者）
 *                                          return { assets: AssetRow[] }
 *
 *   GET    /api/assets/*                 — 反代 S3 内容（任何已认证身份）
 *                                          wildcard params['*'] = storage key（含 / 分隔）
 *                                          404 如果 key 不存在
 *
 *   DELETE /api/assets/*                 — 删除资产 object + DB 行（admin + script 所有者）
 *                                          return { ok: true }
 *
 * manifest 里的 assetUrl 形如 "/api/assets/scripts/<sid>/<uuid>.png"，
 * 前端 <img src> 能直接用。
 */

import { Elysia } from 'elysia';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { requireAdmin, requireAnyIdentity, isResponse } from '../auth-identity';
import { scriptService } from '../services/script-service';
import { assetService, type AssetKind } from '../services/asset-service';
import { getAssetStorage } from '../services/asset-storage';

/** 尝试从 MIME 推一个扩展名（纯为美观/诊断，storage_key 不依赖它） */
function extFromMime(mime: string | undefined): string {
  if (!mime) return '';
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'image/avif': '.avif',
  };
  return map[mime.toLowerCase()] ?? '';
}

/** 从 DATABASE_URL 解析出 db name 放进资产 metadata，便于在 OSS 控制台分辨
 *  是哪个 ivn 实例产的 object（比如 ivn_dev / ivn_prod 共用一个 bucket 时）。
 *  解析失败返回 'unknown'。只在 module 加载时算一次。 */
const DB_NAME = (() => {
  const raw = process.env.DATABASE_URL ?? '';
  const m = raw.match(/\/([^/?]+)(?:\?|$)/);
  return m?.[1] ?? 'unknown';
})();

/** 验证 admin 调用方确实是 script 所有者 */
async function requireScriptOwner(
  request: Request,
  scriptId: string,
): Promise<{ adminUserId: string } | Response> {
  const id = await requireAdmin(request);
  if (isResponse(id)) return id;
  const ownerId = await scriptService.getOwnerId(scriptId);
  if (!ownerId) {
    return new Response(JSON.stringify({ error: 'Script not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (ownerId !== id.userId) {
    return new Response(JSON.stringify({ error: 'Not script owner' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return { adminUserId: id.userId };
}

// ============================================================================
// Routes mounted on /api
// ============================================================================

export const assetRoutes = new Elysia({ prefix: '/api' })
  // POST /scripts/:id/assets — 上传
  .post('/scripts/:id/assets', async ({ params, request }) => {
    const auth = await requireScriptOwner(request, params.id);
    if (isResponse(auth)) return auth;

    // 解析 multipart（Elysia/Bun 原生 FormData）
    let form: FormData;
    try {
      form = await request.formData();
    } catch (err) {
      return new Response(
        JSON.stringify({ error: 'Invalid multipart payload', detail: String(err) }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const file = form.get('file');
    if (!(file instanceof File)) {
      return new Response(
        JSON.stringify({ error: 'Missing "file" field in multipart body' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const kindRaw = form.get('kind');
    const kind: AssetKind = kindRaw === 'background' ? 'background' : 'sprite';

    const assetId = randomUUID();
    const contentType = file.type || 'application/octet-stream';
    const ext = extFromMime(contentType);
    const storageKey = `scripts/${params.id}/${assetId}${ext}`;

    // 流式上传到 S3（lib-storage Upload 自动分片）
    const storage = getAssetStorage();
    // Bun 的 File 有 .stream() 方法返回 Web ReadableStream
    const webStream = file.stream();
    // 带上溯源 metadata：哪个 app / 哪个 db / 哪个 script / 什么用途 / 谁传的
    // S3 metadata 值必须 ASCII，所以不带原始文件名（那个在 DB `original_name` 列里）
    const metadata: Record<string, string> = {
      app: 'ivn-engine',
      db: DB_NAME,
      'script-id': params.id,
      'asset-kind': kind,
      'uploaded-by': auth.adminUserId,
    };
    try {
      await storage.put(storageKey, webStream, contentType, metadata);
    } catch (err) {
      console.error('[assets] upload failed:', err);
      return new Response(
        JSON.stringify({ error: 'Upload to storage failed', detail: String(err) }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const row = await assetService.create({
      id: assetId,
      scriptId: params.id,
      kind,
      storageKey,
      originalName: file.name || null,
      contentType,
      sizeBytes: file.size ?? null,
    });

    return new Response(
      JSON.stringify({
        id: row.id,
        storageKey: row.storageKey,
        assetUrl: `/api/assets/${row.storageKey}`,
        kind: row.kind,
        contentType: row.contentType,
        sizeBytes: row.sizeBytes,
      }),
      { status: 201, headers: { 'Content-Type': 'application/json' } },
    );
  })

  // GET /scripts/:id/assets — 列表（诊断/清理用）
  .get('/scripts/:id/assets', async ({ params, request }) => {
    const auth = await requireScriptOwner(request, params.id);
    if (isResponse(auth)) return auth;
    const assets = await assetService.listByScript(params.id);
    return { assets };
  })

  // GET /assets/* — 反代 S3
  .get('/assets/*', async ({ params, request }) => {
    const ident = await requireAnyIdentity(request);
    if (isResponse(ident)) return ident;
    const key = (params as Record<string, string>)['*'];
    if (!key) {
      return new Response(JSON.stringify({ error: 'Missing key' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 先查 DB 确认资产存在（也防止 key 遍历到 bucket 里不属于 IVN 的 object）
    const row = await assetService.getByKey(key);
    if (!row) {
      return new Response(JSON.stringify({ error: 'Asset not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const storage = getAssetStorage();
    const obj = await storage.get(key);
    if (!obj) {
      return new Response(JSON.stringify({ error: 'Object missing from storage' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const headers = new Headers({
      'Content-Type': row.contentType ?? obj.contentType,
      // 立绘/背景是不可变的（storage_key 含 uuid），长缓存
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    if (obj.contentLength !== undefined) {
      headers.set('Content-Length', String(obj.contentLength));
    }
    return new Response(obj.stream as ReadableStream<Uint8Array>, { headers });
  })

  // DELETE /assets/* — 删除
  .delete('/assets/*', async ({ params, request }) => {
    const ident = await requireAdmin(request);
    if (isResponse(ident)) return ident;
    const key = (params as Record<string, string>)['*'];
    if (!key) {
      return new Response(JSON.stringify({ error: 'Missing key' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const row = await assetService.getByKey(key);
    if (!row) {
      return new Response(JSON.stringify({ error: 'Asset not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // 验所有者（script 归他 → 可以删）
    const ownerId = await scriptService.getOwnerId(row.scriptId);
    if (ownerId !== ident.userId) {
      return new Response(JSON.stringify({ error: 'Not script owner' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const storage = getAssetStorage();
    await storage.delete(key);
    await assetService.delete(key, row.scriptId);
    return { ok: true };
  });

// Keep a reference to unused symbols to satisfy lint if any
void Readable;
