/**
 * MODULE_7 Test Fixture — 直接加载编剧原始文档
 *
 * 等效于将 scenario/MODULE_7/ 下所有文档（除 prompt.txt）上传给 Claude，
 * 跳过 Architect Agent，每个文档作为一个完整 PromptSegment。
 *
 * 文档 → Segment 映射：
 *   - GM Prompt（第一章/第二章）→ system role, priority 0（按章节条件注入）
 *   - PC Prompt → system role, priority 1（告知 LLM 玩家角色定位）
 *   - 项目策划案 → context role, priority 5（世界观和设计背景）
 *   - 世界观时间线 → context role, priority 8（按需参考）
 *   - 共鸣池场景设定 → context role, priority 8（第二章条件注入）
 */

// Vite ?raw imports — 加载原始文本
import gmPromptCh1 from '../../scenario/MODULE_7/MODULE7_GM_Prompt_序章第一章_v2_3.md?raw';
import gmPromptCh2 from '../../scenario/MODULE_7/MODULE7_GM_Prompt_第二章_共鸣池_v1_9.md?raw';
import pcPrompt from '../../scenario/MODULE_7/MODULE7_PC_Prompt_v1_0.md?raw';
import worldTimeline from '../../scenario/MODULE_7/世界观——时间线（大事年表）_草案v3.md?raw';
import resonancePool from '../../scenario/MODULE_7/共鸣池（地点C）—— 场景完整设定.md?raw';
import projectPlan from '../../scenario/MODULE_7/MODULE7_项目策划案_v1.1.txt?raw';
import initialPromptText from '../../scenario/MODULE_7/prompt.txt?raw';

import type {
  ScriptManifest,
  FlowGraph,
  PromptSegment,
  StateSchema,
  MemoryConfig,
} from '../core/types';
import { estimateTokens } from '../core/memory';

// ============================================================================
// Helper — 计算 contentHash（简单哈希）
// ============================================================================

function simpleHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < Math.min(text.length, 1000); i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

// ============================================================================
// State Schema — 从 GM Prompt 的阶段地图和收束协议中提取
// ============================================================================

const stateSchema: StateSchema = {
  variables: [
    { name: 'chapter', type: 'number', initial: 1, description: '当前章节 (1=序章第一章, 2=共鸣池)' },
    { name: 'stage', type: 'number', initial: 1, description: '当前阶段序号 (1-5)' },
    { name: 'stage_core_experience', type: 'boolean', initial: false, description: '当前阶段核心体验是否已建立' },
    { name: 'turn_count_in_stage', type: 'number', initial: 0, description: '当前阶段内的轮次计数' },
    { name: 'deviation_layers', type: 'number', initial: 0, description: '连续偏离收束协议触发层数 (0-3)', range: { min: 0, max: 3 } },
    { name: 'relationship_stage', type: 'number', initial: 1, description: '与女孩的关系阶段 (1=陌生人 → 6=无言羁绊)', range: { min: 1, max: 6 } },
    { name: 'girl_communication_level', type: 'number', initial: 0, description: '女孩的交流能力 (0=无语言 → 3=简单对话)', range: { min: 0, max: 3 } },
    { name: 'current_location', type: 'string', initial: 'awakening-chamber', description: '当前位置' },
    { name: 'explored_locations', type: 'array', initial: [], description: '已探索的区域列表' },
    { name: 'time_subjective', type: 'string', initial: '刚苏醒', description: '主观经过时间描述' },
    { name: 'sleep_count', type: 'number', initial: 0, description: '玩家入睡次数' },
    { name: 'water_valve_state', type: 'string', initial: 'unknown', description: '共鸣池水阀状态 (unknown/discovered/activated)' },
    { name: 'master_valve_decision', type: 'string', initial: 'none', description: '总阀门决策 (none/open/close)' },
  ],
};

// ============================================================================
// Flow Graphs — 可视化参考（不做运行时路由）
// ============================================================================

const chapter1Flow: FlowGraph = {
  id: 'ch1-flow',
  label: '序章第一章',
  nodes: [
    { id: 'ch1-s1', label: '阶段1：苏醒', promptSegments: [] },
    { id: 'ch1-s2', label: '阶段2：行走', promptSegments: [] },
    { id: 'ch1-s3', label: '阶段3：潜行区', promptSegments: [] },
    { id: 'ch1-s4', label: '阶段4：坠落与邂逅', promptSegments: [] },
    { id: 'ch1-s5', label: '阶段5：同行者', promptSegments: [] },
  ],
  edges: [
    { from: 'ch1-s1', to: 'ch1-s2' },
    { from: 'ch1-s2', to: 'ch1-s3', label: '核心体验建立后' },
    { from: 'ch1-s3', to: 'ch1-s4', label: '坠落' },
    { from: 'ch1-s4', to: 'ch1-s5' },
    { from: 'ch1-s5', to: 'ch1-s5', label: '同行继续（循环）' },
  ],
};

const chapter2Flow: FlowGraph = {
  id: 'ch2-flow',
  label: '第二章：共鸣池',
  nodes: [
    { id: 'ch2-s1', label: '阶段1：时间跳跃苏醒', promptSegments: [] },
    { id: 'ch2-s2', label: '阶段2：涅瓦入口', promptSegments: [] },
    { id: 'ch2-s3', label: '阶段3：共鸣池探索', promptSegments: [] },
    { id: 'ch2-s4', label: '阶段4：总阀门抉择', promptSegments: [] },
    { id: 'ch2-s5', label: '阶段5：余波', promptSegments: [] },
  ],
  edges: [
    { from: 'ch2-s1', to: 'ch2-s2' },
    { from: 'ch2-s2', to: 'ch2-s3' },
    { from: 'ch2-s3', to: 'ch2-s3', label: '继续探索（循环）' },
    { from: 'ch2-s3', to: 'ch2-s4', label: '找到总阀门' },
    { from: 'ch2-s4', to: 'ch2-s5' },
  ],
};

// ============================================================================
// Prompt Segments — 每个文档对应一个完整 Segment
// ============================================================================

const segments: PromptSegment[] = [
  // --- GM Prompts（system role，按章节条件注入）---
  {
    id: 'doc-gm-ch1',
    label: 'GM Prompt 序章第一章 v2.3',
    content: gmPromptCh1,
    contentHash: simpleHash(gmPromptCh1),
    type: 'logic',
    sourceDoc: 'MODULE7_GM_Prompt_序章第一章_v2_3.md',
    role: 'system',
    priority: 0,
    injectionRule: {
      description: '第一章 GM 指令',
      condition: "chapter === 1",
    },
    tokenCount: estimateTokens(gmPromptCh1),
  },
  {
    id: 'doc-gm-ch2',
    label: 'GM Prompt 第二章共鸣池 v1.9',
    content: gmPromptCh2,
    contentHash: simpleHash(gmPromptCh2),
    type: 'logic',
    sourceDoc: 'MODULE7_GM_Prompt_第二章_共鸣池_v1_9.md',
    role: 'system',
    priority: 0,
    injectionRule: {
      description: '第二章 GM 指令',
      condition: "chapter === 2",
    },
    tokenCount: estimateTokens(gmPromptCh2),
  },
  // --- PC Prompt（system role，始终注入）---
  {
    id: 'doc-pc',
    label: 'PC Prompt v1.0',
    content: pcPrompt,
    contentHash: simpleHash(pcPrompt),
    type: 'logic',
    sourceDoc: 'MODULE7_PC_Prompt_v1_0.md',
    role: 'system',
    priority: 1,
    tokenCount: estimateTokens(pcPrompt),
  },
  // --- 项目策划案（context role，背景参考）---
  {
    id: 'doc-project-plan',
    label: '项目策划案 v1.1',
    content: projectPlan,
    contentHash: simpleHash(projectPlan),
    type: 'content',
    sourceDoc: 'MODULE7_项目策划案_v1.1.docx',
    role: 'context',
    priority: 5,
    tokenCount: estimateTokens(projectPlan),
  },
  // --- 世界观时间线（context role，按需参考）---
  {
    id: 'doc-world-timeline',
    label: '世界观时间线 草案v3',
    content: worldTimeline,
    contentHash: simpleHash(worldTimeline),
    type: 'content',
    sourceDoc: '世界观——时间线（大事年表）_草案v3.md',
    role: 'context',
    priority: 8,
    tokenCount: estimateTokens(worldTimeline),
  },
  // --- 共鸣池场景设定（context role，第二章重点参考）---
  {
    id: 'doc-resonance-pool',
    label: '共鸣池场景完整设定',
    content: resonancePool,
    contentHash: simpleHash(resonancePool),
    type: 'content',
    sourceDoc: '共鸣池（地点C）—— 场景完整设定.md',
    role: 'context',
    priority: 8,
    injectionRule: {
      description: '共鸣池场景设定（第二章重点）',
      condition: "chapter === 2",
    },
    tokenCount: estimateTokens(resonancePool),
  },
];

// ============================================================================
// Memory Config
// ============================================================================

const memoryConfig: MemoryConfig = {
  contextBudget: 1000000,
  compressionThreshold: 800000,
  recencyWindow: 10,
  compressionHints: `压缩优先保留：
1. 女孩的具体反应和新行为（语言发展的里程碑）
2. 玩家的关键选择和态度表现
3. 关系阶段变化的触发事件
4. 收束协议触发记录
5. 共鸣池中的关键发现和阀门状态`,
  crossChapterInheritance: {
    inherit: ['relationship_stage', 'girl_communication_level', 'explored_locations', 'sleep_count'],
    exclude: ['turn_count_in_stage', 'deviation_layers', 'stage_core_experience'],
  },
};

// ============================================================================
// Complete Manifest
// ============================================================================

export const module7TestManifest: ScriptManifest = {
  id: 'module-7',
  version: '2.3.0',
  label: 'MODULE_7 互动叙事',
  description: '你在一个陌生的地下设施中苏醒，身边有一个不会说话的女孩。在废墟与微光中，你们将一起探索这个被遗忘的世界。',
  author: '编剧团队',
  tags: ['科幻', '互动叙事', '探索', '废墟'],
  openingMessages: [
    '欢迎来到 MODULE_7 互动叙事体验。',
    '你将扮演一个在地下设施中苏醒的失忆者。身边有一个不会说话的女孩——她似乎认识你，但你对她毫无印象。',
    '在废墟与微光中探索这个被遗忘的世界，做出你的选择。你的每一个行动都会影响故事的走向。',
  ],
  stateSchema,
  memoryConfig,
  enabledTools: ['read_state', 'query_changelog', 'pin_memory', 'query_memory', 'set_mood'],
  initialPrompt: initialPromptText,
  chapters: [
    {
      id: 'chapter-1',
      label: '序章第一章：苏醒',
      flowGraph: chapter1Flow,
      segments,  // 所有 segments，ContextAssembler 按 injectionRule 过滤
    },
    {
      id: 'chapter-2',
      label: '第二章：共鸣池',
      flowGraph: chapter2Flow,
      segments,  // 同上
      inheritsFrom: 'chapter-1',
    },
  ],
};

/** All segment IDs */
export const module7ActiveSegmentIds = segments.map((s) => s.id);

/** Segment hash map for version detection */
export const module7SegmentHashes = new Map(segments.map((s) => [s.id, s.contentHash]));
