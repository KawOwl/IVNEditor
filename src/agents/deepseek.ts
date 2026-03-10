/**
 * Dynamic model provider — reads from model-config-store at call time.
 * Uses @ai-sdk/openai-compatible for all protocols (OpenAI, Anthropic, Gemini, DeepSeek).
 * All modern providers expose OpenAI-compatible /chat/completions endpoints.
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { useModelConfigStore } from '../settings/model-config-store';
import type { ModelConfig } from '../settings/model-config-store';

function createProvider(config: ModelConfig) {
  return createOpenAICompatible({
    name: config.protocol,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });
}

/**
 * Get the configured chat model. Reads from store at call time.
 */
export function getChatModel() {
  const config = useModelConfigStore.getState().chatModel;
  const provider = createProvider(config);
  return provider.chatModel(config.modelName);
}

/**
 * Get the configured embedding model. Reads from store at call time.
 */
export function getEmbeddingModel() {
  const config = useModelConfigStore.getState().embeddingModel;
  if (!config.modelName) {
    throw new Error('Embedding模型未配置。请在设置中配置Embedding模型名称。');
  }
  const provider = createProvider(config);
  return provider.textEmbeddingModel(config.modelName);
}

