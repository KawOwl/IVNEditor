/**
 * LLMSettingsPanel — LLM 配置面板
 *
 * 编剧用来配置文本生成和向量嵌入模型的连接信息。
 * 数据存储在 localStorage，不跟剧本走。
 */

import { useState } from 'react';
import {
  useLLMSettingsStore,
  PROVIDER_OPTIONS,
} from '../../stores/llm-settings-store';
import type { LLMProviderType } from '../../core/types';
import { cn } from '../../lib/utils';

// ============================================================================
// Component
// ============================================================================

export function LLMSettingsPanel() {
  const text = useLLMSettingsStore((s) => s.text);
  const embedding = useLLMSettingsStore((s) => s.embedding);
  const embeddingEnabled = useLLMSettingsStore((s) => s.embeddingEnabled);
  const updateText = useLLMSettingsStore((s) => s.updateText);
  const updateEmbedding = useLLMSettingsStore((s) => s.updateEmbedding);
  const setEmbeddingEnabled = useLLMSettingsStore((s) => s.setEmbeddingEnabled);

  const [showTextKey, setShowTextKey] = useState(false);
  const [showEmbeddingKey, setShowEmbeddingKey] = useState(false);

  return (
    <div className="space-y-6">
      {/* Text model */}
      <EndpointSection
        title="文本生成模型"
        endpoint={text}
        onChange={updateText}
        showKey={showTextKey}
        onToggleKey={() => setShowTextKey(!showTextKey)}
      />

      {/* Embedding model */}
      <div className="space-y-3">
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={embeddingEnabled}
            onChange={(e) => setEmbeddingEnabled(e.target.checked)}
            className="rounded border-zinc-600 bg-zinc-900"
          />
          启用向量嵌入模型（记忆模块）
        </label>

        {embeddingEnabled && (
          <EndpointSection
            title="向量嵌入模型"
            endpoint={embedding}
            onChange={updateEmbedding}
            showKey={showEmbeddingKey}
            onToggleKey={() => setShowEmbeddingKey(!showEmbeddingKey)}
          />
        )}
      </div>
    </div>
  );
}

// ============================================================================
// EndpointSection — 单个模型端点配置区
// ============================================================================

function EndpointSection({
  title,
  endpoint,
  onChange,
  showKey,
  onToggleKey,
}: {
  title: string;
  endpoint: { provider: LLMProviderType; baseUrl: string; apiKey: string; model: string };
  onChange: (patch: Partial<typeof endpoint>) => void;
  showKey: boolean;
  onToggleKey: () => void;
}) {
  return (
    <fieldset className="space-y-2.5">
      <legend className="text-xs font-medium text-zinc-300">{title}</legend>

      {/* Provider */}
      <Field label="Provider">
        <select
          value={endpoint.provider}
          onChange={(e) => onChange({ provider: e.target.value as LLMProviderType })}
          className={fieldClass}
        >
          {PROVIDER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </Field>

      {/* Base URL */}
      <Field label="Base URL">
        <input
          type="text"
          value={endpoint.baseUrl}
          onChange={(e) => onChange({ baseUrl: e.target.value })}
          placeholder="https://api.example.com/v1"
          className={fieldClass}
        />
      </Field>

      {/* API Key */}
      <Field label="API Key">
        <div className="flex gap-1.5">
          <input
            type={showKey ? 'text' : 'password'}
            value={endpoint.apiKey}
            onChange={(e) => onChange({ apiKey: e.target.value })}
            placeholder="sk-..."
            className={cn(fieldClass, 'flex-1')}
          />
          <button
            onClick={onToggleKey}
            className="flex-none text-[10px] px-2 py-1 rounded bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            {showKey ? '隐藏' : '显示'}
          </button>
        </div>
      </Field>

      {/* Model */}
      <Field label="Model">
        <input
          type="text"
          value={endpoint.model}
          onChange={(e) => onChange({ model: e.target.value })}
          placeholder="gpt-4o / deepseek-chat / ..."
          className={fieldClass}
        />
      </Field>
    </fieldset>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-2 text-xs text-zinc-500">
      <span className="w-16 flex-none text-right">{label}</span>
      <div className="flex-1">{children}</div>
    </label>
  );
}

const fieldClass =
  'w-full text-xs px-2 py-1.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500';
