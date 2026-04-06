/**
 * LLMSettingsPanel — LLM 配置面板
 *
 * 编剧用来配置文本生成和向量嵌入模型的连接信息。
 * 数据存储在 localStorage，不跟剧本走。
 *
 * Remote 模式下额外显示「从服务器拉取」和「同步到服务器」按钮，
 * 编剧可以将本地配置推送到后端，或从后端拉取当前配置。
 */

import { useState } from 'react';
import {
  useLLMSettingsStore,
  PROVIDER_OPTIONS,
} from '../../stores/llm-settings-store';
import { useAuthStore } from '../../stores/auth-store';
import type { LLMProviderType } from '../../core/types';
import { getEngineMode, getBackendUrl } from '../../core/engine-mode';
import { getTypewriterSpeed, setTypewriterSpeed } from '../NarrativeView';
import { cn } from '../../lib/utils';

// ============================================================================
// Component
// ============================================================================

export function LLMSettingsPanel() {
  const text = useLLMSettingsStore((s) => s.text);
  const embedding = useLLMSettingsStore((s) => s.embedding);
  const embeddingEnabled = useLLMSettingsStore((s) => s.embeddingEnabled);
  const thinkingEnabled = useLLMSettingsStore((s) => s.thinkingEnabled);
  const reasoningFilterEnabled = useLLMSettingsStore((s) => s.reasoningFilterEnabled);
  const updateText = useLLMSettingsStore((s) => s.updateText);
  const updateEmbedding = useLLMSettingsStore((s) => s.updateEmbedding);
  const setEmbeddingEnabled = useLLMSettingsStore((s) => s.setEmbeddingEnabled);
  const setThinkingEnabled = useLLMSettingsStore((s) => s.setThinkingEnabled);
  const setReasoningFilterEnabled = useLLMSettingsStore((s) => s.setReasoningFilterEnabled);

  const [showTextKey, setShowTextKey] = useState(false);
  const [showEmbeddingKey, setShowEmbeddingKey] = useState(false);

  const isRemote = getEngineMode() === 'remote';

  return (
    <div className="space-y-6">
      {/* Remote mode: server sync controls */}
      {isRemote && <ServerSyncSection />}

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

      {/* Thinking mode */}
      <label className="flex items-center gap-2 text-xs text-zinc-400">
        <input
          type="checkbox"
          checked={thinkingEnabled}
          onChange={(e) => setThinkingEnabled(e.target.checked)}
          className="rounded border-zinc-600 bg-zinc-900"
        />
        启用思考模式（DeepSeek enable_thinking）
      </label>

      {/* Reasoning filter */}
      <div className="space-y-1">
        <label className={cn(
          'flex items-center gap-2 text-xs',
          thinkingEnabled ? 'text-zinc-600' : 'text-zinc-400',
        )}>
          <input
            type="checkbox"
            checked={reasoningFilterEnabled}
            onChange={(e) => setReasoningFilterEnabled(e.target.checked)}
            disabled={thinkingEnabled}
            className="rounded border-zinc-600 bg-zinc-900 disabled:opacity-40"
          />
          启发式推理过滤器
        </label>
        <p className="text-[10px] text-zinc-600 ml-5">
          {thinkingEnabled
            ? '思考模式已启用，推理由 API 原生分离，过滤器自动跳过'
            : '从 text 流中启发式分离推理文本（检测 --- / ## / ** 标记）。关闭后全部内容作为叙事输出。即时生效，下次生成时应用。'}
        </p>
      </div>

      {/* Typewriter speed */}
      <TypewriterSpeedSection />
    </div>
  );
}

// ============================================================================
// ServerSyncSection — 服务器配置同步（仅 remote 模式）
// ============================================================================

function TypewriterSpeedSection() {
  const [speed, setSpeed] = useState(() => getTypewriterSpeed());

  const handleChange = (value: number) => {
    setSpeed(value);
    setTypewriterSpeed(value);
  };

  const presets = [
    { label: '慢', value: 20 },
    { label: '中', value: 60 },
    { label: '快', value: 150 },
    { label: '即时', value: 0 },
  ];

  return (
    <fieldset className="space-y-2.5">
      <legend className="text-xs font-medium text-zinc-300">打字机速度</legend>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={200}
          value={speed === 0 ? 200 : speed}
          onChange={(e) => {
            const v = Number(e.target.value);
            handleChange(v >= 200 ? 0 : v);
          }}
          className="flex-1 accent-emerald-500 h-1"
        />
        <span className="text-xs text-zinc-400 font-mono w-20 text-right">
          {speed === 0 ? '即时' : `${speed} 字/秒`}
        </span>
      </div>
      <div className="flex gap-1.5">
        {presets.map((p) => (
          <button
            key={p.label}
            onClick={() => handleChange(p.value)}
            className={cn(
              'text-[10px] px-2 py-0.5 rounded border transition-colors',
              speed === p.value
                ? 'border-emerald-600 text-emerald-400 bg-emerald-950/30'
                : 'border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-zinc-600">
        控制叙事文本的流式显示速度。设为"即时"则跟随 LLM 输出速度。
        <br />
        修改后在下一段生成时生效。
      </p>
    </fieldset>
  );
}

function ServerSyncSection() {
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<{ text: string; type: 'ok' | 'error' } | null>(null);

  const backendUrl = getBackendUrl();

  const handlePull = async () => {
    setSyncing(true);
    setMessage(null);
    try {
      const authHeader = useAuthStore.getState().getAuthHeader();
      const res = await fetch(`${backendUrl}/api/config/llm`, {
        headers: authHeader,
      });
      if (!res.ok) throw new Error(res.status === 403 ? '需要管理员权限' : `HTTP ${res.status}`);
      const cfg = await res.json();

      // 管理员返回完整 API key，直接覆盖本地
      const patch: Record<string, string> = {};
      if (cfg.provider) patch.provider = cfg.provider;
      if (cfg.baseUrl) patch.baseUrl = cfg.baseUrl;
      if (cfg.model) patch.model = cfg.model;
      if (cfg.name) patch.name = cfg.name;
      if (cfg.apiKey) patch.apiKey = cfg.apiKey;

      useLLMSettingsStore.getState().updateText(patch);
      setMessage({ text: '已从服务器拉取配置（含 API Key）', type: 'ok' });
    } catch (err) {
      setMessage({ text: `拉取失败: ${err}`, type: 'error' });
    } finally {
      setSyncing(false);
    }
  };

  const handlePush = async () => {
    setSyncing(true);
    setMessage(null);
    try {
      const authHeader = useAuthStore.getState().getAuthHeader();
      const { text } = useLLMSettingsStore.getState();
      const res = await fetch(`${backendUrl}/api/config/llm`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeader },
        body: JSON.stringify({
          provider: text.provider,
          baseUrl: text.baseUrl,
          apiKey: text.apiKey,
          model: text.model,
          name: text.name,
        }),
      });
      if (!res.ok) throw new Error(res.status === 403 ? '需要管理员权限' : `HTTP ${res.status}`);
      setMessage({ text: '已同步到服务器，新会话将使用此配置', type: 'ok' });
    } catch (err) {
      setMessage({ text: `同步失败: ${err}`, type: 'error' });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="rounded border border-zinc-700 bg-zinc-900/50 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-zinc-300">服务器配置同步</span>
        <span className="text-[10px] text-zinc-600">{backendUrl}</span>
      </div>
      <div className="flex gap-2">
        <button
          onClick={handlePull}
          disabled={syncing}
          className="flex-1 text-[11px] px-2 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100 transition-colors disabled:opacity-50"
        >
          {syncing ? '...' : '从服务器拉取'}
        </button>
        <button
          onClick={handlePush}
          disabled={syncing}
          className="flex-1 text-[11px] px-2 py-1.5 rounded bg-blue-900/50 border border-blue-800/50 text-blue-300 hover:border-blue-600 hover:text-blue-100 transition-colors disabled:opacity-50"
        >
          {syncing ? '...' : '同步到服务器'}
        </button>
      </div>
      {message && (
        <p className={cn(
          'text-[10px]',
          message.type === 'ok' ? 'text-emerald-400' : 'text-red-400',
        )}>
          {message.text}
        </p>
      )}
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
