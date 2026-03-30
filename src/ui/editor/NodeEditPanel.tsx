/**
 * NodeEditPanel — 节点编辑侧边面板
 *
 * Step 3.2: 点击节点后弹出，可修改节点配置。
 * 根据节点类型显示不同的编辑表单。
 */

import { useState, useCallback } from 'react';
import type {
  FlowNode,
  SceneNodeConfig,
  InputNodeConfig,
  CompressNodeConfig,
  StateUpdateNodeConfig,
} from '../../core/types';
import { cn } from '../../lib/utils';

// ============================================================================
// Props
// ============================================================================

export interface NodeEditPanelProps {
  node: FlowNode;
  onSave: (node: FlowNode) => void;
  onClose: () => void;
}

// ============================================================================
// NodeEditPanel
// ============================================================================

export function NodeEditPanel({ node, onSave, onClose }: NodeEditPanelProps) {
  const [label, setLabel] = useState(node.label);
  const [config, setConfig] = useState(node.config);

  const handleSave = useCallback(() => {
    onSave({ ...node, label, config });
  }, [node, label, config, onSave]);

  return (
    <div className="w-80 bg-zinc-900 border-l border-zinc-800 flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
        <h3 className="text-sm font-medium text-zinc-200">编辑节点</h3>
        <button onClick={onClose} className="text-zinc-500 hover:text-zinc-300 text-xs">✕</button>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {/* Label */}
        <Field label="节点名称">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200"
          />
        </Field>

        {/* Type-specific config */}
        <div className="text-xs text-zinc-500 uppercase tracking-wider">
          类型: {config.type}
        </div>

        {config.type === 'scene' && (
          <SceneConfig config={config} onChange={(c) => setConfig(c)} />
        )}
        {config.type === 'input' && (
          <InputConfig config={config} onChange={(c) => setConfig(c)} />
        )}
        {config.type === 'compress' && (
          <CompressConfig config={config} onChange={(c) => setConfig(c)} />
        )}
        {config.type === 'state-update' && (
          <StateUpdateConfig config={config} onChange={(c) => setConfig(c)} />
        )}
        {config.type === 'checkpoint' && (
          <div className="text-sm text-zinc-500">检查点节点，无需额外配置。</div>
        )}
      </div>

      {/* Actions */}
      <div className="flex-none px-4 py-3 border-t border-zinc-800 flex gap-2">
        <button
          onClick={handleSave}
          className="flex-1 px-3 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-500"
        >
          保存
        </button>
        <button
          onClick={onClose}
          className="px-3 py-1.5 text-zinc-400 hover:text-zinc-300 text-sm"
        >
          取消
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Type-specific Configs
// ============================================================================

function SceneConfig({ config, onChange }: {
  config: SceneNodeConfig;
  onChange: (c: SceneNodeConfig) => void;
}) {
  return (
    <>
      <Field label="自动生成（不等玩家输入）">
        <Toggle checked={config.auto} onChange={(auto) => onChange({ ...config, auto })} />
      </Field>
      <Field label="模型">
        <input
          value={config.model ?? ''}
          onChange={(e) => onChange({ ...config, model: e.target.value || undefined })}
          placeholder="默认模型"
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200"
        />
      </Field>
      <Field label="Max Tokens">
        <input
          type="number"
          value={config.maxTokens ?? ''}
          onChange={(e) => onChange({ ...config, maxTokens: e.target.value ? Number(e.target.value) : undefined })}
          placeholder="默认"
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200"
        />
      </Field>
      <Field label="关联 Prompt Segments">
        <div className="text-xs text-zinc-500">
          {config.promptSegments.length > 0
            ? config.promptSegments.join(', ')
            : '无（将在 Prompt 编辑器中关联）'}
        </div>
      </Field>
    </>
  );
}

function InputConfig({ config, onChange }: {
  config: InputNodeConfig;
  onChange: (c: InputNodeConfig) => void;
}) {
  return (
    <>
      <Field label="输入类型">
        <select
          value={config.inputType}
          onChange={(e) => onChange({ ...config, inputType: e.target.value as 'freetext' | 'choice' })}
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200"
        >
          <option value="freetext">自由输入</option>
          <option value="choice">选项选择</option>
        </select>
      </Field>
      <Field label="提示文字">
        <input
          value={config.promptHint ?? ''}
          onChange={(e) => onChange({ ...config, promptHint: e.target.value || undefined })}
          placeholder="引导玩家的提示"
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200"
        />
      </Field>
      <Field label="保存到状态变量">
        <input
          value={config.saveToState ?? ''}
          onChange={(e) => onChange({ ...config, saveToState: e.target.value || undefined })}
          placeholder="例如 player_choice"
          className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200"
        />
      </Field>
    </>
  );
}

function CompressConfig({ config, onChange }: {
  config: CompressNodeConfig;
  onChange: (c: CompressNodeConfig) => void;
}) {
  return (
    <Field label="压缩提示">
      <textarea
        value={config.hintPrompt ?? ''}
        onChange={(e) => onChange({ ...config, hintPrompt: e.target.value || undefined })}
        placeholder="自定义压缩策略提示"
        rows={3}
        className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200 resize-none"
      />
    </Field>
  );
}

function StateUpdateConfig({ config, onChange }: {
  config: StateUpdateNodeConfig;
  onChange: (c: StateUpdateNodeConfig) => void;
}) {
  const updatesJson = JSON.stringify(config.updates, null, 2);
  return (
    <Field label="状态更新 (JSON)">
      <textarea
        value={updatesJson}
        onChange={(e) => {
          try {
            const parsed = JSON.parse(e.target.value);
            onChange({ ...config, updates: parsed });
          } catch {
            // Invalid JSON, don't update
          }
        }}
        rows={4}
        className="w-full bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-200 font-mono resize-none"
      />
    </Field>
  );
}

// ============================================================================
// Shared Components
// ============================================================================

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-zinc-400 mb-1 block">{label}</label>
      {children}
    </div>
  );
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={cn(
        'w-10 h-5 rounded-full relative transition-colors',
        checked ? 'bg-blue-600' : 'bg-zinc-700',
      )}
    >
      <div className={cn(
        'absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform',
        checked ? 'translate-x-5' : 'translate-x-0.5',
      )} />
    </button>
  );
}
