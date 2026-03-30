/**
 * MODULE_7 Test Fixture — 手写 IR 数据
 *
 * Step 4.5: 用于端到端验证的测试剧本。
 * 简化版 MODULE_7 场景：苏醒 → 行走 → 遇到女孩 → 对话选择。
 */

import type {
  ScriptManifest,
  FlowGraph,
  PromptSegment,
  StateSchema,
  MemoryConfig,
} from '../core/types';

// ============================================================================
// State Schema
// ============================================================================

const stateSchema: StateSchema = {
  variables: [
    {
      name: 'girl_language_level',
      type: 'number',
      initial: 0,
      description: '女孩的语言能力等级 (0-3)',
      updatedBy: 'llm',
      range: { min: 0, max: 3 },
    },
    {
      name: 'trust_level',
      type: 'number',
      initial: 0,
      description: '女孩对玩家的信任等级 (0-5)',
      updatedBy: 'llm',
      range: { min: 0, max: 5 },
    },
    {
      name: 'current_area',
      type: 'string',
      initial: 'awakening',
      description: '当前所在区域',
      updatedBy: 'llm',
    },
    {
      name: 'explored_areas',
      type: 'array',
      initial: [],
      description: '已探索的区域列表',
      updatedBy: 'llm',
    },
    {
      name: 'interaction_count',
      type: 'number',
      initial: 0,
      description: '与女孩的互动次数',
      updatedBy: 'llm',
    },
  ],
};

// ============================================================================
// Flow Graph
// ============================================================================

const flowGraph: FlowGraph = {
  id: 'module7-ch1',
  label: 'MODULE_7 第一章',
  nodes: [
    {
      id: 'awakening',
      type: 'scene',
      label: '苏醒',
      config: {
        type: 'scene',
        promptSegments: ['seg-system', 'seg-awakening'],
        auto: true,
      },
    },
    {
      id: 'first-input',
      type: 'input',
      label: '玩家首次行动',
      config: {
        type: 'input',
        inputType: 'freetext',
        promptHint: '你睁开眼睛，发现自己在一个陌生的地方。你想做什么？',
      },
    },
    {
      id: 'walking',
      type: 'scene',
      label: '行走',
      config: {
        type: 'scene',
        promptSegments: ['seg-system', 'seg-walking'],
        auto: false,
      },
    },
    {
      id: 'encounter',
      type: 'scene',
      label: '遇到女孩',
      config: {
        type: 'scene',
        promptSegments: ['seg-system', 'seg-encounter', 'seg-girl-behavior'],
        auto: false,
      },
    },
    {
      id: 'interaction-loop',
      type: 'input',
      label: '与女孩互动',
      config: {
        type: 'input',
        inputType: 'freetext',
        promptHint: '女孩用好奇的眼神看着你...',
      },
    },
    {
      id: 'compress-point',
      type: 'compress',
      label: '记忆压缩',
      config: {
        type: 'compress',
        hintPrompt: '保留：女孩说的具体话语、玩家的关键选择、信任变化',
      },
    },
    {
      id: 'chapter-end',
      type: 'checkpoint',
      label: '第一章结束',
      config: {
        type: 'checkpoint',
        label: '第一章完成',
      },
    },
  ],
  edges: [
    { from: 'awakening', to: 'first-input' },
    { from: 'first-input', to: 'walking' },
    { from: 'walking', to: 'encounter' },
    { from: 'encounter', to: 'interaction-loop' },
    { from: 'interaction-loop', to: 'encounter', condition: "interaction_count < 5" },
    { from: 'interaction-loop', to: 'compress-point', condition: "interaction_count >= 5" },
    { from: 'compress-point', to: 'chapter-end' },
  ],
};

// ============================================================================
// Prompt Segments
// ============================================================================

const segments: PromptSegment[] = [
  {
    id: 'seg-system',
    label: '系统规范',
    content: `你是 MODULE_7 的 GM（游戏主持人）。你控制着一个神秘世界的叙事。

写作风格：
- 第二人称叙述（"你看到..."、"你感受到..."）
- 文学性但不冗长
- 营造神秘、诗意的氛围
- 每次回复 200-400 字

工具使用：
- 每次回复必须调用 update_state 更新相关状态
- 当需要玩家输入时调用 signal_input_needed
- 重要发现用 pin_memory 标记`,
    contentHash: 'sys001',
    type: 'logic',
    sourceDoc: 'GM提示词_序章.md',
    role: 'system',
    priority: 0,
    tokenCount: 150,
  },
  {
    id: 'seg-awakening',
    label: '苏醒场景',
    content: `## 苏醒阶段
玩家在一片朦胧的光芒中醒来。周围是高大的水晶柱，折射出虹彩光芒。
空气中有淡淡的花香，远处传来流水声。

这是一个被遗忘的空间——既不属于任何时代，也不在任何地图上。
玩家只记得自己在做一个梦，然后就来到了这里。

提示玩家探索环境。不要一次展示太多信息。`,
    contentHash: 'awk001',
    type: 'content',
    sourceDoc: 'GM提示词_序章.md',
    role: 'context',
    priority: 10,
    tokenCount: 120,
  },
  {
    id: 'seg-walking',
    label: '行走场景',
    content: `## 行走阶段
玩家离开苏醒的地方，沿着水晶走廊前行。
走廊两侧的水晶越来越大，光芒越来越柔和。
前方出现了一个开阔的空间——像是一个圆形的花园。

在花园中央，有一棵发光的树。树下坐着一个人影。

更新 current_area 为 "crystal-garden"。`,
    contentHash: 'wlk001',
    type: 'content',
    sourceDoc: 'GM提示词_序章.md',
    role: 'context',
    priority: 10,
    tokenCount: 100,
  },
  {
    id: 'seg-encounter',
    label: '遇到女孩场景',
    content: `## 遇到女孩
树下坐着一个年轻女孩，约莫十五六岁。
她有着半透明的淡蓝色长发，穿着由光织成的衣服。
她似乎在低声哼着什么——不是歌，更像是某种旋律碎片。

女孩注意到了玩家的到来。她停止了哼唱，抬起头，
用一双没有瞳孔的银色眼睛看向玩家。

每次互动后 interaction_count += 1。`,
    contentHash: 'enc001',
    type: 'content',
    sourceDoc: 'GM提示词_序章.md',
    role: 'context',
    priority: 10,
    tokenCount: 130,
  },
  {
    id: 'seg-girl-behavior',
    label: '女孩行为规则',
    content: `## 女孩行为规则（根据 girl_language_level）

Level 0: 女孩只能用音调变化和表情回应。无法说任何词语。
Level 1: 女孩开始能发出单音节。"嗯"、"啊"、指物时说"那个"。
Level 2: 女孩能说简单的短句。"你...好"、"好看的"、"不要走"。
Level 3: 女孩能进行简单对话。但仍然有很多词找不到。

随着 interaction_count 增加和玩家的耐心互动，girl_language_level 可能提升。
trust_level 同时影响女孩的开放程度。

当 trust_level >= 3 且 girl_language_level >= 2 时，女孩会主动分享信息。`,
    contentHash: 'girl001',
    type: 'logic',
    sourceDoc: 'GM提示词_序章.md',
    role: 'system',
    priority: 5,
    injectionRule: {
      description: '当与女孩互动时注入行为规则',
      condition: "current_area === 'crystal-garden'",
    },
    tokenCount: 180,
  },
];

// ============================================================================
// Memory Config
// ============================================================================

const memoryConfig: MemoryConfig = {
  contextBudget: 16000,
  compressionThreshold: 12000,
  recencyWindow: 5,
  compressionHints: '压缩时保留：女孩说过的具体话语、玩家的关键选择、信任等级变化原因。',
  crossChapterInheritance: {
    inherit: ['girl_language_level', 'trust_level', 'explored_areas'],
    exclude: ['current_area'],
  },
};

// ============================================================================
// Complete Manifest
// ============================================================================

export const module7TestManifest: ScriptManifest = {
  id: 'module-7-test',
  version: '1.0.0',
  label: 'MODULE_7 测试剧本',
  stateSchema,
  memoryConfig,
  enabledTools: ['read_state', 'pin_memory', 'query_memory', 'set_mood'],
  chapters: [
    {
      id: 'chapter-1',
      label: '第一章：苏醒',
      flowGraph,
      segments,
    },
  ],
};

/** All segment IDs for save data */
export const module7ActiveSegmentIds = segments.map((s) => s.id);

/** Segment hash map for version detection */
export const module7SegmentHashes = new Map(segments.map((s) => [s.id, s.contentHash]));
