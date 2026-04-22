/**
 * ScriptInfoPanel — 剧本信息编辑面板
 *
 * 编辑剧本标签、简介、状态变量、记忆配置、启用工具等元信息。
 */

import { useCallback, useState } from 'react';
import type {
  StateSchema,
  StateVariable,
  StateVariableType,
  MemoryConfig,
  CharacterAsset,
  BackgroundAsset,
  SceneState,
  SpriteState,
  SpriteAsset,
} from '../../core/types';
import { listTools } from '../../core/tool-catalog';
import { useLLMConfigsStore } from '../../stores/llm-configs-store';
import { useAssetUpload } from './use-asset-upload';
import { getBackendUrl } from '../../core/engine-mode';
import { cn } from '../../lib/utils';

/** snake_case id 校验：小写字母开头，可包含小写字母/数字/下划线 */
const ID_PATTERN = /^[a-z][a-z0-9_]*$/;

// ============================================================================
// Props
// ============================================================================

export interface ScriptInfoPanelProps {
  label: string;
  description: string;
  tags: string[];
  stateSchema: StateSchema;
  memoryConfig: MemoryConfig;
  enabledTools: string[];
  initialPrompt: string;
  /** v2.7：剧本 production 使用的 LLM 配置 id。null = 未设置，走 fallback 链 */
  productionLlmConfigId: string | null;
  // M2：VN 视觉资产
  characters: CharacterAsset[];
  backgrounds: BackgroundAsset[];
  defaultScene: SceneState | undefined;
  /** M4：资产上传用的 script id；null = 剧本还没保存过，上传按钮应禁用 */
  loadedScriptId: string | null;
  onLabelChange: (label: string) => void;
  onDescriptionChange: (desc: string) => void;
  onTagsChange: (tags: string[]) => void;
  onStateSchemaChange: (schema: StateSchema) => void;
  onMemoryConfigChange: (config: MemoryConfig) => void;
  onEnabledToolsChange: (tools: string[]) => void;
  onInitialPromptChange: (prompt: string) => void;
  onProductionLlmConfigIdChange: (id: string | null) => void;
  onCharactersChange: (characters: CharacterAsset[]) => void;
  onBackgroundsChange: (backgrounds: BackgroundAsset[]) => void;
  onDefaultSceneChange: (scene: SceneState | undefined) => void;
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
  tags,
  stateSchema,
  memoryConfig,
  enabledTools,
  initialPrompt,
  productionLlmConfigId,
  characters,
  backgrounds,
  defaultScene,
  loadedScriptId,
  onLabelChange,
  onDescriptionChange,
  onTagsChange,
  onStateSchemaChange,
  onMemoryConfigChange,
  onEnabledToolsChange,
  onInitialPromptChange,
  onProductionLlmConfigIdChange,
  onCharactersChange,
  onBackgroundsChange,
  onDefaultSceneChange,
}: ScriptInfoPanelProps) {
  const llmConfigs = useLLMConfigsStore((s) => s.configs);

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
          <Field label="Initial Prompt">
            <input
              type="text"
              value={initialPrompt}
              onChange={(e) => onInitialPromptChange(e.target.value)}
              placeholder="首轮 user message"
              className={inputClass}
            />
          </Field>
          <Field label="生产 LLM">
            <select
              value={productionLlmConfigId ?? ''}
              onChange={(e) =>
                onProductionLlmConfigIdChange(e.target.value || null)
              }
              className={inputClass}
            >
              <option value="">（未设置，走默认）</option>
              {llmConfigs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
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
          {/*
            Memory adapter 选择（Phase 3-B）
            - legacy：截断拼接"压缩"，无外部依赖（默认）
            - llm-summarizer：真 LLM 摘要，用主模型，质量更高
            - mem0：mem0 云端托管向量检索，需要 server 配 MEM0_API_KEY
            切换后**现有 playthrough 的 snapshot 不兼容**，restore 会抛错。
            新剧本选好 provider，跟着剧本一辈子。想切需要另建剧本或重置所有 playthrough。
          */}
          <Field label="记忆适配器">
            <select
              value={memoryConfig.provider ?? 'legacy'}
              onChange={(e) => onMemoryConfigChange({
                ...memoryConfig,
                provider: e.target.value as 'legacy' | 'llm-summarizer' | 'mem0',
              })}
              className={cn(inputClass, 'w-48')}
            >
              <option value="legacy">legacy（截断拼接，默认）</option>
              <option value="llm-summarizer">llm-summarizer（LLM 摘要）</option>
              <option value="mem0">mem0（云端向量检索）</option>
            </select>
          </Field>
          {memoryConfig.provider === 'mem0' && (
            <div className="text-[11px] text-amber-500/80 pl-1">
              ⓘ mem0 需要 server 端配 <code className="bg-zinc-800 px-1 rounded">MEM0_API_KEY</code> 环境变量。
            </div>
          )}
          {memoryConfig.provider && memoryConfig.provider !== 'legacy' && (
            <div className="text-[11px] text-zinc-500 pl-1">
              ⚠ 切换 adapter 后现有 playthrough 的 snapshot 不兼容，restore 会抛错。建议新剧本选好后不再切换。
            </div>
          )}
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

        {/* M2：VN 角色资产 */}
        <Section title="角色资产">
          <CharactersSection
            characters={characters}
            onChange={onCharactersChange}
            loadedScriptId={loadedScriptId}
          />
        </Section>

        {/* M2：VN 背景资产 */}
        <Section title="背景资产">
          <BackgroundsSection
            backgrounds={backgrounds}
            onChange={onBackgroundsChange}
            loadedScriptId={loadedScriptId}
          />
        </Section>

        {/* M2：默认场景 */}
        <Section title="默认场景">
          <DefaultSceneSection
            scene={defaultScene}
            characters={characters}
            backgrounds={backgrounds}
            onChange={onDefaultSceneChange}
          />
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

// ============================================================================
// CharactersSection (M2 Step 2.2)
// ============================================================================
//
// 角色列表 + 每个角色的 sprites 列表。
// id 必须 snake_case（正则 ^[a-z][a-z0-9_]*$）、不重复、不空。
// assetUrl 在 M2 阶段一律留空，等 M4 OSS pipeline 填。
function CharactersSection({
  characters,
  onChange,
  loadedScriptId,
}: {
  characters: CharacterAsset[];
  onChange: (characters: CharacterAsset[]) => void;
  loadedScriptId: string | null;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleAddCharacter = useCallback(() => {
    const id = newId.trim();
    const displayName = newName.trim();
    if (!id || !displayName) {
      setError('id 和 显示名 都不能为空');
      return;
    }
    if (!ID_PATTERN.test(id)) {
      setError('id 必须 snake_case（小写字母开头，仅含小写字母/数字/下划线）');
      return;
    }
    if (characters.some((c) => c.id === id)) {
      setError(`id "${id}" 已存在`);
      return;
    }
    onChange([...characters, { id, displayName, sprites: [] }]);
    setNewId('');
    setNewName('');
    setError(null);
    setExpandedId(id);
  }, [newId, newName, characters, onChange]);

  const handleRemove = useCallback((id: string) => {
    if (!confirm(`删除角色 "${id}"？（其相关的 SpriteAsset 也会一并删除）`)) return;
    onChange(characters.filter((c) => c.id !== id));
    if (expandedId === id) setExpandedId(null);
  }, [characters, onChange, expandedId]);

  const handleUpdateCharacter = useCallback(
    (id: string, patch: Partial<CharacterAsset>) => {
      onChange(characters.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    },
    [characters, onChange],
  );

  return (
    <div className="space-y-2">
      {characters.length === 0 ? (
        <div className="text-[11px] text-zinc-600 italic">尚无角色</div>
      ) : (
        <ul className="space-y-1.5">
          {characters.map((c) => (
            <li key={c.id} className="border border-zinc-800 rounded overflow-hidden">
              <div className="flex items-center gap-2 px-2 py-1.5 bg-zinc-900">
                <span className="font-mono text-xs text-blue-400">{c.id}</span>
                <span className="text-xs text-zinc-300">{c.displayName}</span>
                <span className="text-[10px] text-zinc-600">{c.sprites.length} sprite{c.sprites.length === 1 ? '' : 's'}</span>
                <div className="ml-auto flex gap-1">
                  <button
                    onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}
                    className="text-[11px] px-2 py-0.5 rounded border border-zinc-700 text-zinc-500 hover:text-zinc-300"
                  >
                    {expandedId === c.id ? '收起' : '编辑'}
                  </button>
                  <button
                    onClick={() => handleRemove(c.id)}
                    className="text-[11px] px-2 py-0.5 rounded border border-zinc-700 text-zinc-500 hover:text-red-400"
                  >
                    删除
                  </button>
                </div>
              </div>
              {expandedId === c.id && (
                <div className="px-2 py-2 space-y-2 bg-zinc-900/50">
                  <Field label="显示名">
                    <input
                      type="text"
                      value={c.displayName}
                      onChange={(e) => handleUpdateCharacter(c.id, { displayName: e.target.value })}
                      className={inputClass}
                    />
                  </Field>
                  <div>
                    <div className="text-[10px] text-zinc-500 mb-1">立绘表情</div>
                    <SpritesEditor
                      sprites={c.sprites}
                      onChange={(sprites) => handleUpdateCharacter(c.id, { sprites })}
                      loadedScriptId={loadedScriptId}
                    />
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* 新建角色 */}
      <div className="pt-2 border-t border-zinc-800 space-y-1.5">
        <div className="flex gap-1.5">
          <input
            type="text"
            value={newId}
            onChange={(e) => { setNewId(e.target.value); setError(null); }}
            placeholder="角色 id (snake_case)"
            className={cn(inputClass, 'flex-1')}
          />
          <input
            type="text"
            value={newName}
            onChange={(e) => { setNewName(e.target.value); setError(null); }}
            placeholder="显示名"
            className={cn(inputClass, 'flex-1')}
          />
          <button
            onClick={handleAddCharacter}
            className="text-[11px] px-3 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500"
          >
            + 新角色
          </button>
        </div>
        {error && <div className="text-[11px] text-red-400">{error}</div>}
      </div>
    </div>
  );
}

/** 立绘表情子编辑器（id + label + M4 上传图片） */
function SpritesEditor({
  sprites,
  onChange,
  loadedScriptId,
}: {
  sprites: SpriteAsset[];
  onChange: (sprites: SpriteAsset[]) => void;
  loadedScriptId: string | null;
}) {
  const [newId, setNewId] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { upload, uploading } = useAssetUpload(loadedScriptId, 'sprite');

  const handleAdd = useCallback(() => {
    const id = newId.trim();
    if (!id) {
      setError('表情 id 不能为空');
      return;
    }
    if (!ID_PATTERN.test(id)) {
      setError('id 必须 snake_case');
      return;
    }
    if (sprites.some((s) => s.id === id)) {
      setError(`表情 "${id}" 已存在`);
      return;
    }
    onChange([...sprites, { id, label: newLabel.trim() || undefined }]);
    setNewId('');
    setNewLabel('');
    setError(null);
  }, [newId, newLabel, sprites, onChange]);

  const handleFilePick = async (index: number, file: File | null) => {
    if (!file) return;
    try {
      const assetUrl = await upload(file);
      const next = [...sprites];
      next[index] = { ...next[index]!, assetUrl };
      onChange(next);
    } catch (e) {
      alert(`上传失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div className="space-y-1.5">
      {sprites.length > 0 && (
        <ul className="space-y-1">
          {sprites.map((s, i) => (
            <li key={s.id} className="flex items-center gap-2 text-xs">
              {/* 图片预览 / 占位 */}
              {s.assetUrl ? (
                <img
                  src={`${getBackendUrl()}${s.assetUrl}`}
                  alt={s.id}
                  className="h-10 w-10 rounded border border-zinc-700 object-cover bg-zinc-950"
                />
              ) : (
                <div className="h-10 w-10 rounded border border-dashed border-zinc-700 flex items-center justify-center text-[9px] text-zinc-600">无图</div>
              )}
              <span className="font-mono text-amber-300 w-20 truncate">{s.id}</span>
              <input
                type="text"
                value={s.label ?? ''}
                onChange={(e) => {
                  const next = [...sprites];
                  next[i] = { ...s, label: e.target.value || undefined };
                  onChange(next);
                }}
                placeholder="显示标签"
                className={cn(inputClass, 'flex-1')}
              />
              <label
                className={cn(
                  'text-[11px] px-2 py-1 rounded border border-zinc-700 cursor-pointer',
                  uploading || !loadedScriptId
                    ? 'opacity-40 cursor-not-allowed text-zinc-600'
                    : 'text-zinc-400 hover:text-zinc-200 hover:border-zinc-500',
                )}
                title={loadedScriptId ? '上传 / 替换立绘图' : '请先保存剧本'}
              >
                {s.assetUrl ? '换' : '传'}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={uploading || !loadedScriptId}
                  onChange={(e) => { handleFilePick(i, e.target.files?.[0] ?? null); e.target.value = ''; }}
                />
              </label>
              <button
                onClick={() => onChange(sprites.filter((_, j) => j !== i))}
                className="text-[11px] px-2 rounded border border-zinc-700 text-zinc-500 hover:text-red-400"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-1.5">
        <input
          type="text"
          value={newId}
          onChange={(e) => { setNewId(e.target.value); setError(null); }}
          placeholder="新表情 id"
          className={cn(inputClass, 'flex-1')}
        />
        <input
          type="text"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="标签（可选）"
          className={cn(inputClass, 'flex-1')}
        />
        <button
          onClick={handleAdd}
          className="text-[11px] px-2 rounded border border-zinc-700 text-zinc-500 hover:text-zinc-300"
        >
          +
        </button>
      </div>
      {error && <div className="text-[11px] text-red-400">{error}</div>}
    </div>
  );
}

// ============================================================================
// BackgroundsSection (M2 Step 2.3)
// ============================================================================
function BackgroundsSection({
  backgrounds,
  onChange,
  loadedScriptId,
}: {
  backgrounds: BackgroundAsset[];
  onChange: (backgrounds: BackgroundAsset[]) => void;
  loadedScriptId: string | null;
}) {
  const [newId, setNewId] = useState('');
  const [newLabel, setNewLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const { upload, uploading } = useAssetUpload(loadedScriptId, 'background');

  const handleFilePick = async (index: number, file: File | null) => {
    if (!file) return;
    try {
      const assetUrl = await upload(file);
      const next = [...backgrounds];
      next[index] = { ...next[index]!, assetUrl };
      onChange(next);
    } catch (e) {
      alert(`上传失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleAdd = useCallback(() => {
    const id = newId.trim();
    if (!id) {
      setError('背景 id 不能为空');
      return;
    }
    if (!ID_PATTERN.test(id)) {
      setError('id 必须 snake_case');
      return;
    }
    if (backgrounds.some((b) => b.id === id)) {
      setError(`背景 "${id}" 已存在`);
      return;
    }
    onChange([...backgrounds, { id, label: newLabel.trim() || undefined }]);
    setNewId('');
    setNewLabel('');
    setError(null);
  }, [newId, newLabel, backgrounds, onChange]);

  return (
    <div className="space-y-2">
      {backgrounds.length === 0 ? (
        <div className="text-[11px] text-zinc-600 italic">尚无背景</div>
      ) : (
        <ul className="space-y-1">
          {backgrounds.map((b, i) => (
            <li key={b.id} className="flex items-center gap-2 text-xs">
              {b.assetUrl ? (
                <img
                  src={`${getBackendUrl()}${b.assetUrl}`}
                  alt={b.id}
                  className="h-10 w-16 rounded border border-zinc-700 object-cover bg-zinc-950"
                />
              ) : (
                <div className="h-10 w-16 rounded border border-dashed border-zinc-700 flex items-center justify-center text-[9px] text-zinc-600">无图</div>
              )}
              <span className="font-mono text-cyan-300 w-32 truncate">{b.id}</span>
              <input
                type="text"
                value={b.label ?? ''}
                onChange={(e) => {
                  const next = [...backgrounds];
                  next[i] = { ...b, label: e.target.value || undefined };
                  onChange(next);
                }}
                placeholder="显示标签"
                className={cn(inputClass, 'flex-1')}
              />
              <label
                className={cn(
                  'text-[11px] px-2 py-1 rounded border border-zinc-700 cursor-pointer',
                  uploading || !loadedScriptId
                    ? 'opacity-40 cursor-not-allowed text-zinc-600'
                    : 'text-zinc-400 hover:text-zinc-200 hover:border-zinc-500',
                )}
                title={loadedScriptId ? '上传 / 替换背景图' : '请先保存剧本'}
              >
                {b.assetUrl ? '换' : '传'}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={uploading || !loadedScriptId}
                  onChange={(e) => { handleFilePick(i, e.target.files?.[0] ?? null); e.target.value = ''; }}
                />
              </label>
              <button
                onClick={() => onChange(backgrounds.filter((_, j) => j !== i))}
                className="text-[11px] px-2 rounded border border-zinc-700 text-zinc-500 hover:text-red-400"
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="pt-2 border-t border-zinc-800 space-y-1.5">
        <div className="flex gap-1.5">
          <input
            type="text"
            value={newId}
            onChange={(e) => { setNewId(e.target.value); setError(null); }}
            placeholder="背景 id (snake_case)"
            className={cn(inputClass, 'flex-1')}
          />
          <input
            type="text"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="标签（可选）"
            className={cn(inputClass, 'flex-1')}
          />
          <button
            onClick={handleAdd}
            className="text-[11px] px-3 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500"
          >
            + 新背景
          </button>
        </div>
        {error && <div className="text-[11px] text-red-400">{error}</div>}
      </div>
    </div>
  );
}

// ============================================================================
// DefaultSceneSection (M2 Step 2.4)
// ============================================================================
//
// 开场背景 + 可选开场立绘（单个，未来可扩）。
// 构造的 SceneState：
//   { background: <id> | null, sprites: [{id,emotion,position}] | [] }
function DefaultSceneSection({
  scene,
  characters,
  backgrounds,
  onChange,
}: {
  scene: SceneState | undefined;
  characters: CharacterAsset[];
  backgrounds: BackgroundAsset[];
  onChange: (scene: SceneState | undefined) => void;
}) {
  const hasOpeningSprite = !!scene && scene.sprites.length > 0;
  const firstSprite: SpriteState | undefined = scene?.sprites[0];

  const updateScene = useCallback((patch: Partial<SceneState>) => {
    const base: SceneState = scene ?? { background: null, sprites: [] };
    onChange({ ...base, ...patch });
  }, [scene, onChange]);

  const toggleOpeningSprite = useCallback((on: boolean) => {
    if (on) {
      const firstChar = characters[0];
      const firstEmotion = firstChar?.sprites[0];
      if (!firstChar || !firstEmotion) {
        alert('请先在"角色资产"中至少建一个角色 + 一个表情');
        return;
      }
      updateScene({
        sprites: [{ id: firstChar.id, emotion: firstEmotion.id, position: 'center' }],
      });
    } else {
      updateScene({ sprites: [] });
    }
  }, [characters, updateScene]);

  const updateSprite = useCallback((patch: Partial<SpriteState>) => {
    if (!firstSprite) return;
    updateScene({ sprites: [{ ...firstSprite, ...patch }] });
  }, [firstSprite, updateScene]);

  const selectedChar = firstSprite ? characters.find((c) => c.id === firstSprite.id) : undefined;
  const selectedBg = scene?.background ? backgrounds.find((b) => b.id === scene.background) : undefined;
  const selectedSprite = firstSprite && selectedChar
    ? selectedChar.sprites.find((s) => s.id === firstSprite.emotion)
    : undefined;

  return (
    <div className="space-y-2">
      <Field label="开场背景">
        <select
          value={scene?.background ?? ''}
          onChange={(e) => updateScene({ background: e.target.value || null })}
          className={inputClass}
          disabled={backgrounds.length === 0}
        >
          <option value="">（无背景 / 纯黑幕）</option>
          {backgrounds.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label ? `${b.label} · ${b.id}` : b.id}
            </option>
          ))}
        </select>
      </Field>
      {backgrounds.length === 0 && (
        <div className="text-[11px] text-zinc-500 italic ml-[5.5rem]">先在上方"背景资产"中新建至少一个背景</div>
      )}

      {/* M4 Step 4.5：所选背景 + 开场立绘的缩略预览，叠加展示 */}
      {selectedBg && (
        <div className="ml-[5.5rem] pt-1">
          <div className="relative w-40 h-24 rounded border border-zinc-700 overflow-hidden bg-zinc-900">
            {selectedBg.assetUrl ? (
              <img
                src={`${getBackendUrl()}${selectedBg.assetUrl}`}
                alt={selectedBg.id}
                className="absolute inset-0 w-full h-full object-cover"
              />
            ) : (
              <div className="absolute inset-0 flex items-center justify-center text-[10px] font-mono text-zinc-500">
                {selectedBg.label ?? selectedBg.id}
              </div>
            )}
            {selectedSprite && firstSprite && (
              <div
                className={cn(
                  'absolute bottom-0 flex items-end justify-center',
                  firstSprite.position === 'left' ? 'left-1 w-1/3' :
                  firstSprite.position === 'right' ? 'right-1 w-1/3' :
                  'left-1/2 -translate-x-1/2 w-1/3',
                )}
              >
                {selectedSprite.assetUrl ? (
                  <img
                    src={`${getBackendUrl()}${selectedSprite.assetUrl}`}
                    alt={selectedChar?.id}
                    className="max-h-[85%] object-contain"
                  />
                ) : (
                  <div className="text-[9px] font-mono text-zinc-300 bg-zinc-800/80 rounded px-1">
                    {selectedChar?.id}:{selectedSprite.id}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="pt-1">
        <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
          <input
            type="checkbox"
            checked={hasOpeningSprite}
            onChange={(e) => toggleOpeningSprite(e.target.checked)}
            disabled={characters.length === 0}
            className="rounded border-zinc-600 bg-zinc-900"
          />
          <span>有开场立绘</span>
          {characters.length === 0 && (
            <span className="text-[10px] text-zinc-600">（先建角色）</span>
          )}
        </label>
      </div>

      {hasOpeningSprite && firstSprite && (
        <div className="pl-6 space-y-1.5">
          <Field label="角色">
            <select
              value={firstSprite.id}
              onChange={(e) => {
                const newCharId = e.target.value;
                const newChar = characters.find((c) => c.id === newCharId);
                const newEmotion = newChar?.sprites[0]?.id ?? firstSprite.emotion;
                updateSprite({ id: newCharId, emotion: newEmotion });
              }}
              className={inputClass}
            >
              {characters.map((c) => (
                <option key={c.id} value={c.id}>{c.displayName} · {c.id}</option>
              ))}
            </select>
          </Field>
          <Field label="表情">
            <select
              value={firstSprite.emotion}
              onChange={(e) => updateSprite({ emotion: e.target.value })}
              className={inputClass}
              disabled={!selectedChar || selectedChar.sprites.length === 0}
            >
              {selectedChar?.sprites.length === 0 && <option value="">（角色无表情）</option>}
              {selectedChar?.sprites.map((s) => (
                <option key={s.id} value={s.id}>{s.label ? `${s.label} · ${s.id}` : s.id}</option>
              ))}
            </select>
          </Field>
          <Field label="位置">
            <select
              value={firstSprite.position ?? 'center'}
              onChange={(e) => updateSprite({ position: e.target.value as 'left' | 'center' | 'right' })}
              className={inputClass}
            >
              <option value="left">left</option>
              <option value="center">center</option>
              <option value="right">right</option>
            </select>
          </Field>
        </div>
      )}
    </div>
  );
}
