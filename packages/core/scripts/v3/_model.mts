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

export const buildModelFromEnv = (): LanguageModel => {
  const provider = requireEnv('LLM_PROVIDER');
  const baseURL = requireEnv('LLM_BASE_URL');
  const apiKey = requireEnv('LLM_API_KEY');
  const modelName = requireEnv('LLM_MODEL');

  if (provider === 'anthropic') {
    const p = createAnthropic({
      baseURL,
      apiKey,
      headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
    });
    return p(modelName);
  }
  if (provider === 'openai-compatible') {
    const p = createOpenAICompatible({ baseURL, apiKey, name: 'v3-script' });
    return p(modelName);
  }
  throw new Error(
    `unsupported LLM_PROVIDER='${provider}'。当前支持 anthropic / openai-compatible`,
  );
};
