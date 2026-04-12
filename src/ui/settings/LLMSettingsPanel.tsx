/**
 * LLMSettingsPanel — LLM 配置 + 通用设置面板
 *
 * v2.7 改为多套命名配置管理：
 *   - 顶部列出 llm_configs 表里的所有配置
 *   - 新增 / 编辑 / 删除通过对话框完成
 *   - 所有操作都走后端 /api/llm-configs（见 llm-configs-store.ts）
 *
 * 同时保留"打字机速度"等通用 UI 设置（只影响当前浏览器）。
 */

import { useEffect, useMemo, useState } from 'react';
import {
  useLLMConfigsStore,
  type LLMConfigEntry,
  type LLMConfigPayload,
} from '../../stores/llm-configs-store';
import { getTypewriterSpeed, setTypewriterSpeed } from '../NarrativeView';
import { cn } from '../../lib/utils';

// ============================================================================
// Constants
// ============================================================================

const PROVIDER_OPTIONS: { value: string; label: string }[] = [
  { value: 'openai-compatible', label: 'OpenAI Compatible' },
  { value: 'anthropic', label: 'Anthropic' },
];

const DEFAULT_NEW_CONFIG: LLMConfigPayload = {
  name: '',
  provider: 'openai-compatible',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  thinkingEnabled: false,
  reasoningFilterEnabled: true,
  maxOutputTokens: 8192,
};

// ============================================================================
// Main Panel
// ============================================================================

export function LLMSettingsPanel() {
  const configs = useLLMConfigsStore((s) => s.configs);
  const loaded = useLLMConfigsStore((s) => s.loaded);
  const loading = useLLMConfigsStore((s) => s.loading);
  const refresh = useLLMConfigsStore((s) => s.refresh);

  // 首次加载
  useEffect(() => {
    if (!loaded && !loading) refresh().catch(() => {});
  }, [loaded, loading, refresh]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const editingEntry = useMemo(
    () => (editingId ? configs.find((c) => c.id === editingId) ?? null : null),
    [editingId, configs],
  );

  return (
    <div className="space-y-6">
      {/* LLM Configs 列表 */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium text-zinc-300">LLM 配置</h3>
          <button
            onClick={() => setCreating(true)}
            className="text-[11px] px-2 py-1 rounded bg-emerald-900/50 border border-emerald-800/50 text-emerald-300 hover:bg-emerald-800/50 transition-colors"
          >
            + 新建
          </button>
        </div>

        {!loaded && <p className="text-[10px] text-zinc-600">加载中...</p>}
        {loaded && configs.length === 0 && (
          <div className="rounded border border-zinc-800 bg-zinc-900/50 px-3 py-4 text-center">
            <p className="text-[11px] text-zinc-500">
              还没有配置。点右上角"+ 新建"添加一套 LLM 配置。
            </p>
          </div>
        )}

        <div className="space-y-1">
          {configs.map((c) => (
            <ConfigListRow key={c.id} entry={c} onEdit={() => setEditingId(c.id)} />
          ))}
        </div>
      </section>

      {/* 通用 UI 设置 */}
      <TypewriterSpeedSection />

      {/* 编辑对话框 */}
      {editingEntry && (
        <ConfigEditDialog
          mode="edit"
          initial={entryToPayload(editingEntry)}
          entryId={editingEntry.id}
          onClose={() => setEditingId(null)}
        />
      )}
      {creating && (
        <ConfigEditDialog
          mode="create"
          initial={DEFAULT_NEW_CONFIG}
          onClose={() => setCreating(false)}
        />
      )}
    </div>
  );
}

function entryToPayload(entry: LLMConfigEntry): LLMConfigPayload {
  return {
    name: entry.name,
    provider: entry.provider,
    baseUrl: entry.baseUrl,
    apiKey: entry.apiKey,
    model: entry.model,
    thinkingEnabled: entry.thinkingEnabled,
    reasoningFilterEnabled: entry.reasoningFilterEnabled,
    maxOutputTokens: entry.maxOutputTokens,
  };
}

// ============================================================================
// ConfigListRow
// ============================================================================

function ConfigListRow({
  entry,
  onEdit,
}: {
  entry: LLMConfigEntry;
  onEdit: () => void;
}) {
  const deleteConfig = useLLMConfigsStore((s) => s.delete);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    if (!confirm(`确定删除 "${entry.name}"？`)) return;
    setDeleting(true);
    try {
      const result = await deleteConfig(entry.id);
      if (result.ok === false) {
        if (result.reason === 'referenced') {
          alert(
            `无法删除："${entry.name}" 被 ${result.count} 条游玩记录引用。` +
            `\n请先归档或删除相关游玩记录。`,
          );
        } else if (result.reason === 'not-found') {
          alert('配置已不存在');
        }
      }
    } catch (err) {
      alert(`删除失败: ${err}`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div
      className={cn(
        'flex items-center gap-2 px-3 py-2 rounded border border-zinc-800 bg-zinc-900/50',
        'hover:border-zinc-600 transition-colors',
        deleting && 'opacity-50',
      )}
    >
      <div className="flex-1 min-w-0">
        <div className="text-xs text-zinc-200 truncate">{entry.name}</div>
        <div className="text-[10px] text-zinc-600 flex items-center gap-1.5 mt-0.5">
          <span>{entry.provider}</span>
          <span>·</span>
          <span className="truncate">{entry.model}</span>
          {entry.thinkingEnabled && (
            <>
              <span>·</span>
              <span className="text-amber-500">thinking</span>
            </>
          )}
        </div>
      </div>
      <button
        onClick={onEdit}
        className="flex-none text-[10px] px-2 py-1 text-zinc-500 hover:text-zinc-200 transition-colors"
      >
        编辑
      </button>
      <button
        onClick={handleDelete}
        disabled={deleting}
        className="flex-none text-[10px] px-2 py-1 text-zinc-600 hover:text-red-400 transition-colors disabled:opacity-50"
      >
        删除
      </button>
    </div>
  );
}

// ============================================================================
// ConfigEditDialog
// ============================================================================

function ConfigEditDialog({
  mode,
  initial,
  entryId,
  onClose,
}: {
  mode: 'create' | 'edit';
  initial: LLMConfigPayload;
  entryId?: string;
  onClose: () => void;
}) {
  const create = useLLMConfigsStore((s) => s.create);
  const update = useLLMConfigsStore((s) => s.update);

  const [payload, setPayload] = useState<LLMConfigPayload>(initial);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleSave = async () => {
    setErr(null);
    if (!payload.name.trim()) {
      setErr('请填写名称');
      return;
    }
    if (!payload.apiKey) {
      setErr('请填写 API Key');
      return;
    }
    setSaving(true);
    try {
      if (mode === 'create') {
        await create(payload);
      } else if (entryId) {
        await update(entryId, payload);
      }
      onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-lg bg-zinc-900 border border-zinc-700 rounded-lg p-5 space-y-4 max-h-[90vh] overflow-y-auto shadow-2xl">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-zinc-100">
            {mode === 'create' ? '新建 LLM 配置' : '编辑 LLM 配置'}
          </h3>
          <button
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 text-lg leading-none"
          >
            ×
          </button>
        </div>

        <div className="space-y-3">
          <Field label="名称">
            <input
              type="text"
              value={payload.name}
              onChange={(e) => setPayload({ ...payload, name: e.target.value })}
              placeholder="DeepSeek Chat / Claude Sonnet 4.5"
              className={fieldClass}
            />
          </Field>

          <Field label="Provider">
            <select
              value={payload.provider}
              onChange={(e) => setPayload({ ...payload, provider: e.target.value })}
              className={fieldClass}
            >
              {PROVIDER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Base URL">
            <input
              type="text"
              value={payload.baseUrl}
              onChange={(e) => setPayload({ ...payload, baseUrl: e.target.value })}
              placeholder="https://api.example.com/v1"
              className={fieldClass}
            />
          </Field>

          <Field label="API Key">
            <div className="flex gap-1.5">
              <input
                type={showKey ? 'text' : 'password'}
                value={payload.apiKey}
                onChange={(e) => setPayload({ ...payload, apiKey: e.target.value })}
                placeholder="sk-..."
                className={cn(fieldClass, 'flex-1')}
              />
              <button
                onClick={() => setShowKey(!showKey)}
                className="flex-none text-[10px] px-2 py-1 rounded bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                {showKey ? '隐藏' : '显示'}
              </button>
            </div>
          </Field>

          <Field label="Model">
            <input
              type="text"
              value={payload.model}
              onChange={(e) => setPayload({ ...payload, model: e.target.value })}
              placeholder="deepseek-chat / claude-sonnet-4-5-20250929"
              className={fieldClass}
            />
          </Field>

          <Field label="Max tokens">
            <input
              type="number"
              min={1}
              max={32768}
              value={payload.maxOutputTokens}
              onChange={(e) =>
                setPayload({ ...payload, maxOutputTokens: Number(e.target.value) || 8192 })
              }
              className={fieldClass}
            />
          </Field>

          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={payload.thinkingEnabled}
              onChange={(e) => setPayload({ ...payload, thinkingEnabled: e.target.checked })}
              className="rounded border-zinc-600 bg-zinc-900"
            />
            启用思考模式（DeepSeek enable_thinking）
          </label>

          <div className="space-y-1">
            <label
              className={cn(
                'flex items-center gap-2 text-xs',
                payload.thinkingEnabled ? 'text-zinc-600' : 'text-zinc-400',
              )}
            >
              <input
                type="checkbox"
                checked={payload.reasoningFilterEnabled}
                onChange={(e) =>
                  setPayload({ ...payload, reasoningFilterEnabled: e.target.checked })
                }
                disabled={payload.thinkingEnabled}
                className="rounded border-zinc-600 bg-zinc-900 disabled:opacity-40"
              />
              启发式推理过滤器
            </label>
            <p className="text-[10px] text-zinc-600 ml-5 leading-snug">
              {payload.thinkingEnabled
                ? '思考模式已启用，推理由 API 原生分离，过滤器自动跳过'
                : '从 text 流中启发式分离推理文本（检测 --- / ## / ** 标记）'}
            </p>
          </div>
        </div>

        {err && <p className="text-[11px] text-red-400">{err}</p>}

        <div className="flex gap-2 justify-end pt-2 border-t border-zinc-800">
          <button
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="text-xs px-3 py-1.5 rounded bg-emerald-700 text-white hover:bg-emerald-600 transition-colors disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// TypewriterSpeedSection
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
