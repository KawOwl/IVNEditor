/**
 * Playthrough Routes — 游玩记录 HTTP 接口
 *
 * 所有接口都要求 playerAuth。ownership 校验通过 service 层的 WHERE 子句强制。
 *
 * v2.6 改动：创建 playthrough 的 API 契约扩展：
 *   - 旧字段 scriptId（= scripts.id）依然接受，后端会查该 script 当前
 *     published 版本 id 塞给 playthroughs.script_version_id（玩家走正式
 *     published 流程）
 *   - 新字段 scriptVersionId 可以直接指定具体版本 id（6.4 编辑器试玩走这个）
 *   - 新字段 kind：'production' | 'playtest'，默认 'production'
 *
 * 列表时 join scripts + script_versions 拿 scriptTitle（scripts.label）。
 */

import { Elysia } from 'elysia';
import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db';
import { playthroughService } from '../services/playthrough-service';
import { scriptVersionService } from '../services/script-version-service';
import { requirePlayer, isResponse } from '../auth-identity';

export const playthroughRoutes = new Elysia({ prefix: '/api/playthroughs' })

  // GET / — 列出当前用户的游玩记录
  //
  // 过滤参数：
  //   - scriptId: 按原始 script id 过滤（先查 published 版本，拿到其 version id）
  //   - scriptVersionId: 按具体版本 id 过滤
  //   - kind: 'production' | 'playtest'
  .get('/', async ({ query, request }) => {
    const id = await requirePlayer(request);
    if (isResponse(id)) return id;

    const q = query as { scriptId?: string; scriptVersionId?: string; kind?: 'production' | 'playtest' };
    // 如果传了 scriptId 而不是 scriptVersionId，尝试转成 version id（用当前 published）
    let filterVersionId = q.scriptVersionId;
    if (!filterVersionId && q.scriptId) {
      const published = await scriptVersionService.getCurrentPublished(q.scriptId);
      filterVersionId = published?.id;
      // 如果剧本没 published 版本，filter 就留空——但前端在这种情况下
      // 拿到空列表是合理的
      if (!filterVersionId) {
        return { playthroughs: [] };
      }
    }

    const playthroughs = await playthroughService.list({
      userId: id.userId,
      scriptVersionId: filterVersionId,
      kind: q.kind,
    });

    // 附加 scriptTitle（batch join scripts 表拿）
    const versionIds = Array.from(new Set(playthroughs.map((pt) => pt.scriptVersionId)));
    const titleMap = new Map<string, string>();  // versionId → scriptLabel
    if (versionIds.length > 0) {
      const joined = await db
        .select({
          versionId: schema.scriptVersions.id,
          scriptLabel: schema.scripts.label,
        })
        .from(schema.scriptVersions)
        .innerJoin(schema.scripts, eq(schema.scriptVersions.scriptId, schema.scripts.id))
        .where(inArray(schema.scriptVersions.id, versionIds));
      for (const row of joined) {
        titleMap.set(row.versionId, row.scriptLabel);
      }
    }

    const withTitles = playthroughs.map((pt) => ({
      ...pt,
      scriptTitle: titleMap.get(pt.scriptVersionId) ?? pt.scriptVersionId,
    }));

    return { playthroughs: withTitles };
  })

  // POST / — 为当前用户创建新游玩
  .post('/', async ({ body, request }) => {
    const id = await requirePlayer(request);
    if (isResponse(id)) return id;

    const input = body as {
      scriptId?: string;           // legacy：按剧本 id 创建，用当前 published 版本
      scriptVersionId?: string;    // 新：直接指定版本 id（试玩用）
      kind?: 'production' | 'playtest';
      title?: string;
    };

    // 解析出实际要用的 script_version_id
    let versionId: string | undefined;
    let chapterId: string | undefined;

    if (input.scriptVersionId) {
      const version = await scriptVersionService.getById(input.scriptVersionId);
      if (!version) {
        return new Response(JSON.stringify({ error: 'Version not found' }), { status: 404 });
      }
      versionId = version.id;
      chapterId = version.manifest.chapters[0]?.id ?? 'ch1';
    } else if (input.scriptId) {
      const published = await scriptVersionService.getCurrentPublished(input.scriptId);
      if (!published) {
        return new Response(
          JSON.stringify({ error: 'Script has no published version' }),
          { status: 404 },
        );
      }
      versionId = published.id;
      chapterId = published.manifest.chapters[0]?.id ?? 'ch1';
    } else {
      return new Response(
        JSON.stringify({ error: 'Missing scriptId or scriptVersionId' }),
        { status: 400 },
      );
    }

    const result = await playthroughService.create({
      userId: id.userId,
      scriptVersionId: versionId,
      chapterId: chapterId,
      title: input.title,
      kind: input.kind ?? 'production',
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
