/**
 * ScriptInfoPanel — 剧本信息编辑面板
 *
 * 编辑剧本标签、简介、状态变量、记忆配置、启用工具等元信息。
 */

import { useCallback, useState } from 'react';
import type { StateSchema, StateVariable, StateVariableType, MemoryConfig } from '../../core/types';
import { listTools } from '../../core/tool-catalog';
import { cn } from '../../lib/utils';

// ============================================================================
// Props
// ============================================================================

export interface ScriptInfoPanelProps {
  label: string;
  description: string;
  version: string;
  tags: string[];
  stateSchema: StateSchema;
  memoryConfig: MemoryConfig;
  enabledTools: string[];
  initialPrompt: string;
  onLabelChange: (label: string) => void;
  onDescriptionChange: (desc: string) => void;
  onVersionChange: (version: string) => void;
  onTagsChange: (tags: string[]) => void;
  onStateSchemaChange: (schema: StateSchema) => void;
  onMemoryConfigChange: (config: MemoryConfig) => void;
  onEnabledToolsChange: (tools: string[]) => void;
  onInitialPromptChange: (prompt: string) => void;
}

// ============================================================================
// Available optional tools —— 从 tool-catalog 单一真源派生
// ============================================================================

const OPTIONAL_TOOLS = listTools({ required: false });

const VAR_TYPES: StateVariableType[] = ['number', 'string', 'boolean', 'array', 'object'];

// ============================================================================
// Component
// ============================================================================

export function ScriptInfoPanel({
  label,
  description,
  version,
  tags,
  stateSchema,
  memoryConfig,
  enabledTools,
  initialPrompt,
  onLabelChange,
  onDescriptionChange,
  onVersionChange,
  onTagsChange,
  onStateSchemaChange,
  onMemoryConfigChange,
  onEnabledToolsChange,
  onInitialPromptChange,
}: ScriptInfoPanelProps) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="p-3 space-y-5">
        {/* Basic info */}
        <Section title="基本信息">
          <Field label="剧本名称">
            <input
              type="text"
              value={label}
              onChange={(e) => onLabelChange(e.target.value)}
              placeholder="未命名剧本"
              className={inputClass}
            />
          </Field>
          <Field label="简介">
            <textarea
              value={description}
              onChange={(e) => onDescriptionChange(e.target.value)}
              placeholder="剧本简介..."
              rows={3}
              className={cn(inputClass, 'resize-none')}
            />
          </Field>
          <Field label="版本号">
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={version}
                onChange={(e) => onVersionChange(e.target.value)}
                placeholder="0.0.0"
                className={cn(inputClass, 'w-24 font-mono')}
              />
              <span className="text-[10px] text-zinc-600">保存时自动 +1</span>
            </div>
          </Field>
          <Field label="Initial Prompt">
            <input
              type="text"
              value={initialPrompt}
              onChange={(e) => onInitialPromptChange(e.target.value)}
              placeholder="首轮 user message"
              className={inputClass}
            />
          </Field>
        </Section>

        {/* Tags */}
        <Section title="标签">
          <TagsEditor tags={tags} onChange={onTagsChange} />
        </Section>

        {/* State variables */}
        <Section title="状态变量">
          <StateVariableEditor
            variables={stateSchema.variables}
            onChange={(vars) => onStateSchemaChange({ ...stateSchema, variables: vars })}
          />
        </Section>

        {/* Memory config */}
        <Section title="记忆配置">
          <Field label="Token 预算">
            <input
              type="number"
              value={memoryConfig.contextBudget}
              onChange={(e) => onMemoryConfigChange({ ...memoryConfig, contextBudget: parseInt(e.target.value) || 0 })}
              className={cn(inputClass, 'w-32')}
            />
          </Field>
          <Field label="压缩阈值">
            <input
              type="number"
              value={memoryConfig.compressionThreshold}
              onChange={(e) => onMemoryConfigChange({ ...memoryConfig, compressionThreshold: parseInt(e.target.value) || 0 })}
              className={cn(inputClass, 'w-32')}
            />
          </Field>
          <Field label="最近保留条数">
            <input
              type="number"
              value={memoryConfig.recencyWindow}
              onChange={(e) => onMemoryConfigChange({ ...memoryConfig, recencyWindow: parseInt(e.target.value) || 0 })}
              className={cn(inputClass, 'w-20')}
              min={1}
              max={100}
            />
          </Field>
        </Section>

        {/* Enabled tools */}
        <Section title="启用工具">
          <div className="space-y-1.5">
            {OPTIONAL_TOOLS.map((tool) => (
              <label key={tool.name} className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={enabledTools.includes(tool.name)}
                  onChange={(e) => {
                    if (e.target.checked) {
                      onEnabledToolsChange([...enabledTools, tool.name]);
                    } else {
                      onEnabledToolsChange(enabledTools.filter((t) => t !== tool.name));
                    }
                  }}
                  className="rounded border-zinc-600 bg-zinc-900"
                />
                <span>{tool.uiLabel}</span>
                <span className="text-[10px] text-zinc-600 font-mono">{tool.name}</span>
                <span className="text-[10px] text-zinc-500" title={tool.uiDescription}>
                  {tool.uiDescription.slice(0, 24)}{tool.uiDescription.length > 24 ? '…' : ''}
                </span>
              </label>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

// ============================================================================
// StateVariableEditor
// ============================================================================

function StateVariableEditor({
  variables,
  onChange,
}: {
  variables: StateVariable[];
  onChange: (vars: StateVariable[]) => void;
}) {
  const handleAdd = useCallback(() => {
    onChange([
      ...variables,
      { name: 'new_var', type: 'number', initial: 0, description: '' },
    ]);
  }, [variables, onChange]);

  const handleRemove = useCallback((idx: number) => {
    onChange(variables.filter((_, i) => i !== idx));
  }, [variables, onChange]);

  const handleUpdate = useCallback((idx: number, patch: Partial<StateVariable>) => {
    onChange(variables.map((v, i) => i === idx ? { ...v, ...patch } : v));
  }, [variables, onChange]);

  return (
    <div className="space-y-2">
      {variables.map((v, idx) => (
        <div key={idx} className="flex items-start gap-1.5 text-xs">
          <input
            type="text"
            value={v.name}
            onChange={(e) => handleUpdate(idx, { name: e.target.value })}
            placeholder="变量名"
            className={cn(inputClass, 'w-24 font-mono')}
          />
          <select
            value={v.type}
            onChange={(e) => handleUpdate(idx, { type: e.target.value as StateVariableType })}
            className={cn(inputClass, 'w-20')}
          >
            {VAR_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <input
            type="text"
            value={JSON.stringify(v.initial)}
            onChange={(e) => {
              try { handleUpdate(idx, { initial: JSON.parse(e.target.value) }); } catch { /* ignore */ }
            }}
            placeholder="初始值"
            className={cn(inputClass, 'w-16 font-mono')}
          />
          <input
            type="text"
            value={v.description}
            onChange={(e) => handleUpdate(idx, { description: e.target.value })}
            placeholder="描述"
            className={cn(inputClass, 'flex-1')}
          />
          <button
            onClick={() => handleRemove(idx)}
            className="flex-none mt-1 text-zinc-600 hover:text-red-400 transition-colors"
          >
            ×
          </button>
        </div>
      ))}
      <button
        onClick={handleAdd}
        className="text-[11px] px-2 py-1 rounded border border-dashed border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 transition-colors"
      >
        + 添加变量
      </button>
    </div>
  );
}

// ============================================================================
// TagsEditor
// ============================================================================

function TagsEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [input, setInput] = useState('');

  const handleAdd = useCallback(() => {
    const tag = input.trim();
    if (tag && !tags.includes(tag)) {
      onChange([...tags, tag]);
    }
    setInput('');
  }, [input, tags, onChange]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag) => (
          <span key={tag} className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-400">
            {tag}
            <button
              onClick={() => onChange(tags.filter((t) => t !== tag))}
              className="text-zinc-600 hover:text-red-400 transition-colors"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-1.5">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }}
          placeholder="输入标签，回车添加"
          className={cn(inputClass, 'flex-1')}
        />
        <button
          onClick={handleAdd}
          className="text-[11px] px-2 py-1 rounded border border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 transition-colors"
        >
          +
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-[10px] font-medium text-zinc-400 uppercase tracking-wider">{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-start gap-2 text-xs text-zinc-500">
      <span className="w-20 flex-none text-right mt-1.5">{label}</span>
      <div className="flex-1">{children}</div>
    </label>
  );
}

const inputClass =
  'w-full text-xs px-2 py-1.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500';
