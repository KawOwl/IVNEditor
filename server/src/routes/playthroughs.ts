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
import { scriptService } from '../services/script-service';
import { llmConfigService } from '../services/llm-config-service';
import { requireAnyIdentity, isResponse } from '../auth-identity';

export const playthroughRoutes = new Elysia({ prefix: '/api/playthroughs' })

  // GET / — 列出当前用户的游玩记录
  //
  // 过滤参数：
  //   - scriptId: 按原始 script id 过滤（展开成该 script 的**所有历史版本**，
  //     这样发布新版本后老 playthrough 仍然出现在列表里，玩家可以回顾/继续）
  //   - scriptVersionId: 按具体版本 id 过滤（编辑器试玩用）
  //   - kind: 'production' | 'playtest'
  .get('/', async ({ query, request }) => {
    const id = await requireAnyIdentity(request);
    if (isResponse(id)) return id;

    const q = query as { scriptId?: string; scriptVersionId?: string; kind?: 'production' | 'playtest' };

    // 解析过滤条件：
    // - 传 scriptVersionId  → 只按该具体版本过滤（编辑器试玩 per-version 独立）
    // - 传 scriptId         → 展开成该 script 的**所有版本** id 数组，
    //                          这样玩家能看到所有历史版本上的游玩记录
    //                          （关键修复：发布新版本后老 playthrough 不被隐藏）
    // - 都不传              → 不按版本过滤，返回该用户的所有 playthroughs
    let filterVersionId: string | undefined;
    let filterVersionIds: string[] | undefined;

    if (q.scriptVersionId) {
      filterVersionId = q.scriptVersionId;
    } else if (q.scriptId) {
      const versions = await scriptVersionService.listByScript(q.scriptId);
      if (versions.length === 0) {
        // 剧本不存在或没有任何版本 → 空列表
        return { playthroughs: [] };
      }
      filterVersionIds = versions.map((v) => v.id);
    }

    const playthroughs = await playthroughService.list({
      userId: id.userId,
      scriptVersionId: filterVersionId,
      scriptVersionIds: filterVersionIds,
      kind: q.kind,
    });

    // 附加 scriptTitle + 版本信息（batch join scripts + script_versions 拿）
    //
    // 返回的字段：
    //   - scriptTitle     用于列表显示"剧本名"
    //   - versionNumber   用于列表显示 "v3" 类版本号
    //   - versionStatus   'draft' | 'published' | 'archived'，前端据此
    //                      对"旧版本"的 playthrough 做视觉降级
    const versionIds = Array.from(new Set(playthroughs.map((pt) => pt.scriptVersionId)));
    interface VersionMeta {
      scriptLabel: string;
      versionNumber: number;
      versionStatus: string;
    }
    const versionMap = new Map<string, VersionMeta>();
    if (versionIds.length > 0) {
      const joined = await db
        .select({
          versionId: schema.scriptVersions.id,
          scriptLabel: schema.scripts.label,
          versionNumber: schema.scriptVersions.versionNumber,
          versionStatus: schema.scriptVersions.status,
        })
        .from(schema.scriptVersions)
        .innerJoin(schema.scripts, eq(schema.scriptVersions.scriptId, schema.scripts.id))
        .where(inArray(schema.scriptVersions.id, versionIds));
      for (const row of joined) {
        versionMap.set(row.versionId, {
          scriptLabel: row.scriptLabel,
          versionNumber: row.versionNumber,
          versionStatus: row.versionStatus,
        });
      }
    }

    const withTitles = playthroughs.map((pt) => {
      const meta = versionMap.get(pt.scriptVersionId);
      return {
        ...pt,
        scriptTitle: meta?.scriptLabel ?? pt.scriptVersionId,
        versionNumber: meta?.versionNumber ?? null,
        versionStatus: meta?.versionStatus ?? null,
      };
    });

    return { playthroughs: withTitles };
  })

  // POST / — 为当前用户创建新游玩
  .post('/', async ({ body, request }) => {
    const id = await requireAnyIdentity(request);
    if (isResponse(id)) return id;

    const input = body as {
      scriptId?: string;           // legacy：按剧本 id 创建，用当前 published 版本
      scriptVersionId?: string;    // 新：直接指定版本 id（试玩用）
      kind?: 'production' | 'playtest';
      title?: string;
      /** v2.7：显式指定 LLM config id（编辑器试玩 override）。缺省走 fallback 链 */
      llmConfigId?: string;
    };

    // 解析出实际要用的 script_version_id
    let versionId: string | undefined;
    let chapterId: string | undefined;
    /** 同时记录对应的 scriptId，用于 llmConfigId 的 fallback 链 */
    let resolvedScriptId: string | undefined;

    if (input.scriptVersionId) {
      const version = await scriptVersionService.getById(input.scriptVersionId);
      if (!version) {
        return new Response(JSON.stringify({ error: 'Version not found' }), { status: 404 });
      }
      versionId = version.id;
      chapterId = version.manifest.chapters[0]?.id ?? 'ch1';
      resolvedScriptId = version.scriptId;
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
      resolvedScriptId = input.scriptId;
    } else {
      return new Response(
        JSON.stringify({ error: 'Missing scriptId or scriptVersionId' }),
        { status: 400 },
      );
    }

    // ========================================================================
    // v2.7 LLM config fallback 链：
    //   1. body.llmConfigId（编辑器 playtest override / 未来的玩家端选择器）
    //   2. script.production_llm_config_id
    //   3. 第一个 llm_config by created_at
    //   4. 找不到 → 400
    // ========================================================================
    let llmConfigId: string | null = null;

    if (input.llmConfigId) {
      const cfg = await llmConfigService.getById(input.llmConfigId);
      if (!cfg) {
        return new Response(
          JSON.stringify({ error: 'llmConfigId not found' }),
          { status: 400 },
        );
      }
      llmConfigId = cfg.id;
    }

    if (!llmConfigId && resolvedScriptId) {
      const script = await scriptService.getById(resolvedScriptId);
      if (script?.productionLlmConfigId) {
        llmConfigId = script.productionLlmConfigId;
      }
    }

    if (!llmConfigId) {
      const first = await llmConfigService.getFirstConfig();
      if (first) llmConfigId = first.id;
    }

    if (!llmConfigId) {
      return new Response(
        JSON.stringify({
          error: 'No LLM config available. Create one under /api/llm-configs first.',
        }),
        { status: 400 },
      );
    }

    const result = await playthroughService.create({
      userId: id.userId,
      scriptVersionId: versionId,
      chapterId: chapterId,
      title: input.title,
      kind: input.kind ?? 'production',
      llmConfigId,
    });
    return result;
  })

  // GET /:id — 游玩详情 + entries（分页），ownership 强制
  .get('/:id', async ({ params, query, request }) => {
    const id = await requireAnyIdentity(request);
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
    const id = await requireAnyIdentity(request);
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
    const id = await requireAnyIdentity(request);
    if (isResponse(id)) return id;

    const deleted = await playthroughService.delete(params.id, id.userId);
    if (!deleted) {
      return new Response(JSON.stringify({ error: 'Playthrough not found' }), { status: 404 });
    }
    return { ok: true };
  });
