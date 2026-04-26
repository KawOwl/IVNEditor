/**
 * Silver-key scenario —— Luna 在图书馆把银钥匙递给玩家，玩家要去找禁门
 *
 * 短小但有 memory 测试价值：3-4 个回合内 LLM 必须记住"银钥匙在玩家手上"
 * + "禁门在 deep_stacks"，否则后面的对话会失忆。
 *
 * 这里只导出**配置数据**，不做任何 IO 或 LLM 调用 —— 让多个 entry 文件
 * （scripted / simulator）复用同一份 scenario。
 */

import type { LiveMemoryEvaluationOptions } from '#internal/evaluation/memory-harness';
import { buildParserManifest } from '#internal/narrative-parser-v2';
import type {
  BackgroundAsset,
  CharacterAsset,
  MemoryConfig,
  PromptSegment,
  ScriptManifest,
  StateSchema,
} from '#internal/types';
import type { PlayerPersona } from '#internal/evaluation/player-simulator';

const characters: CharacterAsset[] = [
  {
    id: 'luna',
    displayName: 'Luna',
    sprites: [
      { id: 'neutral', label: 'neutral' },
      { id: 'smile', label: 'smile' },
    ],
  },
];

const backgrounds: BackgroundAsset[] = [
  { id: 'library_hall', label: 'library hall' },
  { id: 'deep_stacks', label: 'deep stacks' },
];

const stateSchema: StateSchema = {
  variables: [
    {
      name: 'current_scene',
      type: 'string',
      initial: 'library_hall',
      description: '当前场景。',
    },
    {
      name: 'has_silver_key',
      type: 'boolean',
      initial: false,
      description: '玩家是否已经拿到银钥匙。',
    },
    {
      name: 'knows_locked_door',
      type: 'boolean',
      initial: false,
      description: '玩家是否知道禁门位置。',
    },
  ],
};

const systemSegment: PromptSegment = {
  id: 'silver-key-rules',
  label: 'Silver Key Rules',
  content: [
    '你是互动小说 GM。',
    '每轮输出一小段当前格式的叙事 XML，并用 signal_input_needed 给玩家 2-3 个选择。',
    '当玩家收下银钥匙时，调用 update_state 设置 {"has_silver_key":true}。',
    '当 Luna 告诉玩家禁门在书架深处时，调用 update_state 设置 {"knows_locked_door":true,"current_scene":"deep_stacks"}。',
    '不要输出解释性元话语。',
  ].join('\n'),
  contentHash: 'silver-key-rules-hash',
  type: 'content',
  sourceDoc: 'evals/scenarios/silver-key',
  role: 'system',
  priority: 0,
  tokenCount: 120,
};

const manifest = { characters, backgrounds } satisfies Pick<ScriptManifest, 'characters' | 'backgrounds'>;

export const silverKeyScenario: LiveMemoryEvaluationOptions['scenario'] = {
  id: 'silver-key',
  segments: [systemSegment],
  stateSchema,
  initialPrompt: '开场：玩家在图书馆大厅遇见 Luna，她正把一枚银钥匙递给玩家。',
  enabledTools: ['signal_input_needed', 'update_state'],
  tokenBudget: 24000,
  defaultScene: {
    background: 'library_hall',
    sprites: [{ id: 'luna', emotion: 'neutral', position: 'center' }],
  },
  protocolVersion: 'v2-declarative-visual',
  parserManifest: buildParserManifest(manifest),
  characters,
  backgrounds,
};

/** 跑 silver-key 时各 variant 共享的 memory config 模板。每个 variant 拷一份加 provider 字段。 */
export const silverKeyMemoryConfig: MemoryConfig = {
  contextBudget: 4000,
  compressionThreshold: 1,
  recencyWindow: 2,
  compressionHints: '保留 Luna、银钥匙、禁门位置、玩家选择和状态变化。',
};

/** simulator 路径用的 persona 默认值（goal + style）。entry 文件再补 llmConfig。 */
export const silverKeyPersona: Omit<PlayerPersona, 'llmConfig'> = {
  goal: '拿到银钥匙打开禁门',
  style: '话不多，直奔目标',
};
