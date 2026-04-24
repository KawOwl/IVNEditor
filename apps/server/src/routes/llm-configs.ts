/**
 * LLM Config Routes — 多套 LLM 连接配置的管理 API
 *
 * 全部 admin only。GET 返回完整 apiKey（不 mask），和旧
 * /api/config/llm 保持一致的信任模型。
 */

import { Elysia } from 'elysia';
import { llmConfigService } from '#internal/services/llm-config-service';
import { requireAdmin, isResponse } from '#internal/auth-identity';

export const llmConfigRoutes = new Elysia({ prefix: '/api/llm-configs' })

  // ============================================================================
  // GET / — 列出所有配置
  // ============================================================================
  .get('/', async ({ request }) => {
    const auth = await requireAdmin(request);
    if (isResponse(auth)) return auth;

    const configs = await llmConfigService.listAll();
    return { configs };
  })

  // ============================================================================
  // POST / — 新建配置
  // ============================================================================
  .post('/', async ({ body, request }) => {
    const auth = await requireAdmin(request);
    if (isResponse(auth)) return auth;

    const input = body as {
      name?: string;
      provider?: string;
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      maxOutputTokens?: number;
      thinkingEnabled?: boolean | null;
      reasoningEffort?: string | null;
    };

    if (!input.name || !input.provider || !input.baseUrl || !input.apiKey || !input.model) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: name, provider, baseUrl, apiKey, model' }),
        { status: 400 },
      );
    }

    const row = await llmConfigService.create({
      name: input.name,
      provider: input.provider,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      maxOutputTokens: input.maxOutputTokens,
      thinkingEnabled: input.thinkingEnabled,
      reasoningEffort: input.reasoningEffort,
    });
    return { config: row };
  })

  // ============================================================================
  // PATCH /:id — 修改配置
  // ============================================================================
  .patch('/:id', async ({ params, body, request }) => {
    const auth = await requireAdmin(request);
    if (isResponse(auth)) return auth;

    const input = body as Record<string, unknown>;
    const patch = {
      name: input.name as string | undefined,
      provider: input.provider as string | undefined,
      baseUrl: input.baseUrl as string | undefined,
      apiKey: input.apiKey as string | undefined,
      model: input.model as string | undefined,
      maxOutputTokens: input.maxOutputTokens as number | undefined,
      // thinkingEnabled / reasoningEffort 允许显式 null（清除覆盖）；用 `in`
      // 区分 undefined（字段缺省）和 null（显式清空）
      ...(('thinkingEnabled' in input)
        ? { thinkingEnabled: input.thinkingEnabled as boolean | null }
        : {}),
      ...(('reasoningEffort' in input)
        ? { reasoningEffort: input.reasoningEffort as string | null }
        : {}),
    };

    const ok = await llmConfigService.update(params.id, patch);
    if (!ok) {
      return new Response(JSON.stringify({ error: 'Config not found' }), { status: 404 });
    }
    const row = await llmConfigService.getById(params.id);
    return { config: row };
  })

  // ============================================================================
  // DELETE /:id — 删除配置
  // ============================================================================
  //
  // 被 playthrough 引用时返回 409 + count，让前端提示 "还有 N 条游玩记录
  // 在用这个配置，请先处理" 而不是默默失败。
  .delete('/:id', async ({ params, request }) => {
    const auth = await requireAdmin(request);
    if (isResponse(auth)) return auth;

    const result = await llmConfigService.delete(params.id);
    if (result.ok) return { ok: true };

    if (result.error === 'not-found') {
      return new Response(JSON.stringify({ error: 'Config not found' }), { status: 404 });
    }
    if (result.error === 'referenced-by-playthrough') {
      return new Response(
        JSON.stringify({
          error: 'Referenced by existing playthroughs',
          count: result.count,
        }),
        { status: 409 },
      );
    }
    return new Response(JSON.stringify({ error: 'Unknown error' }), { status: 500 });
  });
