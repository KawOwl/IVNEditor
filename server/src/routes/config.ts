/**
 * Config Routes — 后端配置管理（需管理员权限）
 *
 * GET  /api/config/llm       — 获取当前 LLM 配置（管理员可见完整 API key）
 * PUT  /api/config/llm       — 更新 LLM 配置（编剧推送，立即生效）
 * POST /api/config/llm/reset — 重置为环境变量默认值
 */

import { Elysia } from 'elysia';
import { getLLMConfig, updateLLMConfig, resetLLMConfig } from '../storage/llm-config-store';
import { requireAdmin, isResponse } from '../auth-identity';

export const configRoutes = new Elysia({ prefix: '/api/config' })

  // 获取当前配置（管理员返回完整 API key）
  .get('/llm', async ({ request }) => {
    const auth = await requireAdmin(request);
    if (isResponse(auth)) return auth;
    return getLLMConfig();
  })

  // 更新配置（需管理员）
  .put('/llm', async ({ body, request }) => {
    const auth = await requireAdmin(request);
    if (isResponse(auth)) return auth;

    const patch = body as Partial<{
      provider: string;
      baseUrl: string;
      apiKey: string;
      model: string;
      name: string;
    }>;

    updateLLMConfig(patch);
    return { ok: true, config: getLLMConfig() };
  })

  // 重置为默认值（需管理员）
  .post('/llm/reset', async ({ request }) => {
    const auth = await requireAdmin(request);
    if (isResponse(auth)) return auth;
    resetLLMConfig();
    return { ok: true, config: getLLMConfig() };
  });
