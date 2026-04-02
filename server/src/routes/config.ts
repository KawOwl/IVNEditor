/**
 * Config Routes — 后端配置管理
 *
 * GET  /api/config/llm     — 获取当前 LLM 配置（API key 掩码）
 * PUT  /api/config/llm     — 更新 LLM 配置（编剧推送，立即生效）
 * POST /api/config/llm/reset — 重置为环境变量默认值
 */

import { Elysia } from 'elysia';
import { getLLMConfigSafe, updateLLMConfig, resetLLMConfig } from '../storage/llm-config-store';

export const configRoutes = new Elysia({ prefix: '/api/config' })

  // 获取当前配置（API key 掩码）
  .get('/llm', () => {
    return getLLMConfigSafe();
  })

  // 更新配置
  .put('/llm', ({ body }) => {
    const patch = body as Partial<{
      provider: string;
      baseUrl: string;
      apiKey: string;
      model: string;
      name: string;
    }>;

    // 如果前端传了掩码 key（含 ...），忽略 apiKey 字段
    if (patch.apiKey && patch.apiKey.includes('...')) {
      delete patch.apiKey;
    }

    updateLLMConfig(patch);
    return { ok: true, config: getLLMConfigSafe() };
  })

  // 重置为默认值
  .post('/llm/reset', () => {
    resetLLMConfig();
    return { ok: true, config: getLLMConfigSafe() };
  });
