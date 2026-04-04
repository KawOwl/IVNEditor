/**
 * LLM Settings Store — 编剧端 LLM 配置持久化
 *
 * 存储在 localStorage，不入 IndexedDB（不跟剧本走）。
 * 提供 ProviderConfig → LLMConfig 的转换方法，供 PlayPanel 等消费。
 */

import { create } from 'zustand';
import type { ProviderConfig, ModelEndpoint, LLMProviderType } from '../core/types';
import type { LLMConfig } from '../core/llm-client';

// ============================================================================
// Constants
// ============================================================================

const STORAGE_KEY = 'ivn-llm-settings';

export const PROVIDER_OPTIONS: { value: LLMProviderType; label: string }[] = [
  { value: 'openai-compatible', label: 'OpenAI Compatible' },
  { value: 'anthropic', label: 'Anthropic' },
];

const DEFAULT_TEXT_ENDPOINT: ModelEndpoint = {
  provider: 'openai-compatible',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  name: 'deepseek',
};

const DEFAULT_EMBEDDING_ENDPOINT: ModelEndpoint = {
  provider: 'openai-compatible',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  name: 'deepseek-embedding',
};

// ============================================================================
// Store
// ============================================================================

export interface LLMSettingsState {
  text: ModelEndpoint;
  embedding: ModelEndpoint;
  embeddingEnabled: boolean;
  /** 启用模型内置思考模式（DeepSeek enable_thinking 等） */
  thinkingEnabled: boolean;

  // Actions
  updateText: (patch: Partial<ModelEndpoint>) => void;
  updateEmbedding: (patch: Partial<ModelEndpoint>) => void;
  setEmbeddingEnabled: (enabled: boolean) => void;
  setThinkingEnabled: (enabled: boolean) => void;
}

function loadFromStorage(): Pick<LLMSettingsState, 'text' | 'embedding' | 'embeddingEnabled' | 'thinkingEnabled'> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { text: DEFAULT_TEXT_ENDPOINT, embedding: DEFAULT_EMBEDDING_ENDPOINT, embeddingEnabled: false, thinkingEnabled: false };
    const parsed = JSON.parse(raw);
    return {
      text: { ...DEFAULT_TEXT_ENDPOINT, ...parsed.text },
      embedding: { ...DEFAULT_EMBEDDING_ENDPOINT, ...parsed.embedding },
      embeddingEnabled: parsed.embeddingEnabled ?? false,
      thinkingEnabled: parsed.thinkingEnabled ?? false,
    };
  } catch {
    return { text: DEFAULT_TEXT_ENDPOINT, embedding: DEFAULT_EMBEDDING_ENDPOINT, embeddingEnabled: false, thinkingEnabled: false };
  }
}

function saveToStorage(state: Pick<LLMSettingsState, 'text' | 'embedding' | 'embeddingEnabled' | 'thinkingEnabled'>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    text: state.text,
    embedding: state.embedding,
    embeddingEnabled: state.embeddingEnabled,
    thinkingEnabled: state.thinkingEnabled,
  }));
}

export const useLLMSettingsStore = create<LLMSettingsState>((set, get) => ({
  ...loadFromStorage(),

  updateText: (patch) => {
    const next = { ...get().text, ...patch };
    set({ text: next });
    saveToStorage({ ...get(), text: next });
  },

  updateEmbedding: (patch) => {
    const next = { ...get().embedding, ...patch };
    set({ embedding: next });
    saveToStorage({ ...get(), embedding: next });
  },

  setEmbeddingEnabled: (enabled) => {
    set({ embeddingEnabled: enabled });
    saveToStorage({ ...get(), embeddingEnabled: enabled });
  },

  setThinkingEnabled: (enabled) => {
    set({ thinkingEnabled: enabled });
    saveToStorage({ ...get(), thinkingEnabled: enabled });
  },
}));

// ============================================================================
// Helpers — 供 core 消费
// ============================================================================

/** 从 settings store 获取 ProviderConfig（core 接口） */
export function getProviderConfig(): ProviderConfig {
  const { text, embedding, embeddingEnabled } = useLLMSettingsStore.getState();
  return {
    text,
    embedding: embeddingEnabled ? embedding : undefined,
  };
}

/** 从 ModelEndpoint 转换为 LLMClient 所需的 LLMConfig */
export function endpointToLLMConfig(endpoint: ModelEndpoint): LLMConfig {
  const { thinkingEnabled } = useLLMSettingsStore.getState();
  return {
    provider: endpoint.provider,
    baseURL: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    model: endpoint.model,
    name: endpoint.name,
    thinkingEnabled,
  };
}

/** 快捷方法：获取当前文本模型的 LLMConfig */
export function getTextLLMConfig(): LLMConfig {
  return endpointToLLMConfig(useLLMSettingsStore.getState().text);
}
