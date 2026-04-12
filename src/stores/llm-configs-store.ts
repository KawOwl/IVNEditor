/**
 * LLM Configs Store — 前端的多套 LLM 配置状态
 *
 * v2.7 起 LLM 配置全部由后端管理（llm_configs 表），admin 登录后
 * 从 /api/llm-configs 拉一次缓存。UI 操作走这里的 actions，
 * 内部转发到后端。
 *
 * 对比老的 llm-settings-store（已删）：
 *  - 不再读 localStorage，也不再写
 *  - 单例状态是一个 configs 数组，不是"单个 text endpoint + 单个 embedding endpoint"
 *  - apiKey 明文保存，admin 能看到
 */

import { create } from 'zustand';
import { getBackendUrl } from '../core/engine-mode';
import { fetchWithAuth } from './player-session-store';
import type { LLMConfig } from '../core/llm-client';

// ============================================================================
// Types
// ============================================================================

/** llm_configs 表的一行（前端视图） */
export interface LLMConfigEntry {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  thinkingEnabled: boolean;
  reasoningFilterEnabled: boolean;
  maxOutputTokens: number;
  createdAt: string;
  updatedAt: string;
}

/** 创建 / 更新时的 payload */
export type LLMConfigPayload = Omit<LLMConfigEntry, 'id' | 'createdAt' | 'updatedAt'>;

export interface LLMConfigsState {
  configs: LLMConfigEntry[];
  loaded: boolean;
  loading: boolean;
  error: string | null;

  /** 从后端拉取所有 configs */
  refresh: () => Promise<void>;
  /** 新建 config */
  create: (payload: LLMConfigPayload) => Promise<LLMConfigEntry>;
  /** 更新 config（partial patch） */
  update: (id: string, patch: Partial<LLMConfigPayload>) => Promise<void>;
  /**
   * 删除 config。后端若返回 409（被 playthrough 引用），
   * resolve 成 `{ ok: false, referencedCount }` 让 UI 能提示用户。
   */
  delete: (id: string) => Promise<
    | { ok: true }
    | { ok: false; reason: 'not-found' }
    | { ok: false; reason: 'referenced'; count: number }
  >;
  /** 同步查询一条 config（用于 AI 改写 / PlayPanel 取完整配置） */
  getById: (id: string | null | undefined) => LLMConfigEntry | undefined;
}

// ============================================================================
// Store
// ============================================================================

export const useLLMConfigsStore = create<LLMConfigsState>((set, get) => ({
  configs: [],
  loaded: false,
  loading: false,
  error: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetchWithAuth(`${getBackendUrl()}/api/llm-configs`);
      if (!res.ok) {
        // 非 admin 身份读不到；静默置空
        set({ configs: [], loaded: true, loading: false });
        return;
      }
      const data = (await res.json()) as { configs: LLMConfigEntry[] };
      set({ configs: data.configs ?? [], loaded: true, loading: false });
    } catch (err) {
      set({ error: String(err), loading: false });
    }
  },

  create: async (payload) => {
    const res = await fetchWithAuth(`${getBackendUrl()}/api/llm-configs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    const data = (await res.json()) as { config: LLMConfigEntry };
    set((state) => ({ configs: [...state.configs, data.config] }));
    return data.config;
  },

  update: async (id, patch) => {
    const res = await fetchWithAuth(`${getBackendUrl()}/api/llm-configs/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    const data = (await res.json()) as { config: LLMConfigEntry };
    set((state) => ({
      configs: state.configs.map((c) => (c.id === id ? data.config : c)),
    }));
  },

  delete: async (id) => {
    const res = await fetchWithAuth(`${getBackendUrl()}/api/llm-configs/${id}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      set((state) => ({ configs: state.configs.filter((c) => c.id !== id) }));
      return { ok: true } as const;
    }
    if (res.status === 404) {
      return { ok: false, reason: 'not-found' } as const;
    }
    if (res.status === 409) {
      const body = await res.json().catch(() => ({ count: 0 }));
      return { ok: false, reason: 'referenced', count: Number(body.count ?? 0) } as const;
    }
    throw new Error(`HTTP ${res.status}`);
  },

  getById: (id) => {
    if (!id) return undefined;
    return get().configs.find((c) => c.id === id);
  },
}));

// ============================================================================
// Helper: 把 entry 转成 LLMClient 需要的 LLMConfig
// ============================================================================

export function entryToLLMConfig(entry: LLMConfigEntry): LLMConfig {
  return {
    provider: entry.provider,
    baseURL: entry.baseUrl,
    apiKey: entry.apiKey,
    model: entry.model,
    name: entry.name,
    thinkingEnabled: entry.thinkingEnabled,
    reasoningFilterEnabled: entry.reasoningFilterEnabled,
  };
}
