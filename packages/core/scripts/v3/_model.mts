import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModel } from 'ai';

const requireEnv = (name: string): string => {
  const v = Bun.env[name];
  if (!v) {
    throw new Error(
      `missing env: ${name}。需要 LLM_PROVIDER / LLM_BASE_URL / LLM_API_KEY / LLM_MODEL`,
    );
  }
  return v;
};

// LLM_THINKING_ENABLED env 解析：
//   true / on / 1   → 强制 thinking on
//   false / off / 0 → 强制 thinking off
//   缺省 / 其他     → null（不动 model default；DeepSeek V4 系列 default 是 on）
const parseThinkingEnabled = (): boolean | null => {
  const raw = (Bun.env.LLM_THINKING_ENABLED ?? '').toLowerCase();
  if (raw === 'true' || raw === 'on' || raw === '1') return true;
  if (raw === 'false' || raw === 'off' || raw === '0') return false;
  return null;
};

export const buildModelFromEnv = (): LanguageModel => {
  const provider = requireEnv('LLM_PROVIDER');
  const baseURL = requireEnv('LLM_BASE_URL');
  const apiKey = requireEnv('LLM_API_KEY');
  const modelName = requireEnv('LLM_MODEL');
  const thinkingEnabled = parseThinkingEnabled();

  if (provider === 'anthropic') {
    // Anthropic thinking 走 providerOptions.anthropic.reasoning，留待后续
    // 实验需要时按 packages/core/src/llm-client.mts 同款移植即可
    const p = createAnthropic({
      baseURL,
      apiKey,
      headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
    });
    return p(modelName);
  }
  if (provider === 'openai-compatible') {
    // DeepSeek V4 thinking 模式注入：transformRequestBody 把
    // body.thinking={type:'enabled'|'disabled'} 塞进去（AI SDK 原生没该字段）
    // 参考 packages/core/src/llm-client.mts:316-330
    const p = createOpenAICompatible({
      baseURL,
      apiKey,
      name: 'v3-script',
      transformRequestBody:
        thinkingEnabled !== null
          ? (body) => ({
              ...body,
              thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' },
            })
          : undefined,
    });
    return p(modelName);
  }
  throw new Error(
    `unsupported LLM_PROVIDER='${provider}'。当前支持 anthropic / openai-compatible`,
  );
};
