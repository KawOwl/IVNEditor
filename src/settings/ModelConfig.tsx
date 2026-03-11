/**
 * ModelConfig - UI for configuring AI model providers.
 * Two slots: chat model and embedding model.
 * Each slot: protocol dropdown, base URL, API key, model name.
 */

import { useState } from 'react';
import {
  useModelConfigStore,
  DEFAULT_BASE_URLS,
  DEFAULT_MODEL_NAMES,
} from './model-config-store';
import type { ModelProtocol, ModelConfig } from './model-config-store';
import { T } from '../theme';

const PROTOCOLS: { value: ModelProtocol; label: string }[] = [
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Gemini' },
];

export function ModelConfigPanel() {
  const chatModel = useModelConfigStore((s) => s.chatModel);
  const embeddingModel = useModelConfigStore((s) => s.embeddingModel);
  const setChatModel = useModelConfigStore((s) => s.setChatModel);
  const setEmbeddingModel = useModelConfigStore((s) => s.setEmbeddingModel);
  const save = useModelConfigStore((s) => s.save);
  const [saved, setSaved] = useState(false);

  const handleSave = () => {
    save();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div style={styles.container}>
      <p style={styles.description}>
        配置 AI 模型的连接信息。所有协议均通过 OpenAI Compatible 接口通信。
      </p>

      <ModelSlot
        title="对话模型 (Chat)"
        config={chatModel}
        onChange={(patch) => {
          setChatModel(patch);
          setSaved(false);
        }}
        defaultModelKey="chat"
      />

      <ModelSlot
        title="Embedding 模型"
        config={embeddingModel}
        onChange={(patch) => {
          setEmbeddingModel(patch);
          setSaved(false);
        }}
        defaultModelKey="embedding"
      />

      <button
        style={{
          ...styles.saveBtn,
          ...(saved ? styles.saveBtnSaved : {}),
        }}
        onClick={handleSave}
      >
        {saved ? '已保存' : '保存配置'}
      </button>
    </div>
  );
}

// ─── ModelSlot sub-component ──────────────────────────

function ModelSlot({
  title,
  config,
  onChange,
  defaultModelKey,
}: {
  title: string;
  config: ModelConfig;
  onChange: (patch: Partial<ModelConfig>) => void;
  defaultModelKey: 'chat' | 'embedding';
}) {
  const [showKey, setShowKey] = useState(false);

  const handleProtocolChange = (protocol: ModelProtocol) => {
    onChange({
      protocol,
      baseURL: DEFAULT_BASE_URLS[protocol],
      modelName: DEFAULT_MODEL_NAMES[protocol][defaultModelKey],
    });
  };

  return (
    <div style={styles.slotCard}>
      <h3 style={styles.slotTitle}>{title}</h3>

      {/* Protocol */}
      <div style={styles.field}>
        <label style={styles.fieldLabel}>协议类型</label>
        <select
          style={styles.select}
          value={config.protocol}
          onChange={(e) => handleProtocolChange(e.target.value as ModelProtocol)}
        >
          {PROTOCOLS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {/* Base URL */}
      <div style={styles.field}>
        <label style={styles.fieldLabel}>Base URL</label>
        <input
          style={styles.input}
          type="text"
          value={config.baseURL}
          onChange={(e) => onChange({ baseURL: e.target.value })}
          placeholder={DEFAULT_BASE_URLS[config.protocol]}
        />
      </div>

      {/* API Key */}
      <div style={styles.field}>
        <label style={styles.fieldLabel}>API Key</label>
        <div style={styles.keyRow}>
          <input
            style={{ ...styles.input, flex: 1 }}
            type={showKey ? 'text' : 'password'}
            value={config.apiKey}
            onChange={(e) => onChange({ apiKey: e.target.value })}
            placeholder="sk-..."
          />
          <button
            style={styles.toggleKeyBtn}
            onClick={() => setShowKey(!showKey)}
          >
            {showKey ? '隐藏' : '显示'}
          </button>
        </div>
        {config.apiKey && config.apiKey === (import.meta.env.VITE_DEEPSEEK_API_KEY ?? '') && (
          <span style={styles.envHint}>来自环境变量</span>
        )}
      </div>

      {/* Model Name */}
      <div style={styles.field}>
        <label style={styles.fieldLabel}>模型名称</label>
        <input
          style={styles.input}
          type="text"
          value={config.modelName}
          onChange={(e) => onChange({ modelName: e.target.value })}
          placeholder={DEFAULT_MODEL_NAMES[config.protocol][defaultModelKey] || '选填'}
        />
      </div>
    </div>
  );
}

// ─── Styles ──────────────────────────────────────────

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '16px',
  },
  description: {
    color: T.textTertiary,
    fontSize: '12px',
    marginBottom: '16px',
    lineHeight: '1.5',
  },
  slotCard: {
    background: T.bgSurface,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: T.border,
    borderRadius: T.radiusLg,
    padding: '16px',
    marginBottom: '16px',
  },
  slotTitle: {
    color: T.accent,
    fontSize: '14px',
    margin: '0 0 12px',
    fontWeight: 'bold',
  },
  field: {
    marginBottom: '12px',
  },
  fieldLabel: {
    display: 'block',
    color: T.textTertiary,
    fontSize: '11px',
    marginBottom: '4px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  select: {
    width: '100%',
    padding: '8px 12px',
    background: T.bgElevated,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: T.border,
    borderRadius: T.radius,
    color: T.textPrimary,
    fontSize: '13px',
    fontFamily: 'inherit',
    outline: 'none',
  },
  input: {
    width: '100%',
    padding: '8px 12px',
    background: T.bgElevated,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: T.border,
    borderRadius: T.radius,
    color: T.textPrimary,
    fontSize: '13px',
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box' as const,
  },
  keyRow: {
    display: 'flex',
    gap: '6px',
  },
  toggleKeyBtn: {
    padding: '6px 10px',
    background: T.bgElevated,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: T.border,
    borderRadius: T.radius,
    color: T.textTertiary,
    fontSize: '11px',
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
  },
  envHint: {
    color: T.accent,
    fontSize: '10px',
    marginTop: '2px',
    display: 'inline-block',
  },
  saveBtn: {
    width: '100%',
    padding: '10px',
    background: T.accent,
    borderWidth: '0',
    borderStyle: 'none',
    borderRadius: T.radiusLg,
    color: 'white',
    fontSize: '14px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    marginTop: '8px',
  },
  saveBtnSaved: {
    background: T.success,
    color: 'white',
  },
};
