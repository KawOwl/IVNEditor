/**
 * MODULE_7 Test Fixture — 基于真实文档的 IR 数据
 *
 * Step 4.5: 基于 MODULE_7 序章第一章/第二章的真实 GM Prompt 手写 IR。
 * 用于端到端验证引擎的完整流程。
 */

import type {
  ScriptManifest,
  FlowGraph,
  PromptSegment,
  StateSchema,
  MemoryConfig,
} from '../core/types';

// ============================================================================
// State Schema — 从 GM Prompt 的阶段地图和收束协议中提取
// ============================================================================

const stateSchema: StateSchema = {
  variables: [
    {
      name: 'chapter',
      type: 'number',
      initial: 1,
      description: '当前章节 (1=序章第一章, 2=共鸣池)',
      updatedBy: 'flow',
    },
    {
      name: 'stage',
      type: 'number',
      initial: 1,
      description: '当前阶段序号 (1-5)',
      updatedBy: 'llm',
    },
    {
      name: 'stage_core_experience',
      type: 'boolean',
      initial: false,
      description: '当前阶段核心体验是否已建立',
      updatedBy: 'llm',
    },
    {
      name: 'turn_count_in_stage',
      type: 'number',
      initial: 0,
      description: '当前阶段内的轮次计数',
      updatedBy: 'llm',
    },
    {
      name: 'deviation_layers',
      type: 'number',
      initial: 0,
      description: '连续偏离收束协议触发层数 (0-3)',
      updatedBy: 'llm',
      range: { min: 0, max: 3 },
    },
    {
      name: 'relationship_stage',
      type: 'number',
      initial: 1,
      description: '与女孩的关系阶段 (1=陌生人 → 6=无言羁绊)',
      updatedBy: 'llm',
      range: { min: 1, max: 6 },
    },
    {
      name: 'girl_communication_level',
      type: 'number',
      initial: 0,
      description: '女孩的交流能力 (0=无语言 → 3=简单对话)',
      updatedBy: 'llm',
      range: { min: 0, max: 3 },
    },
    {
      name: 'current_location',
      type: 'string',
      initial: 'awakening-chamber',
      description: '当前位置',
      updatedBy: 'llm',
    },
    {
      name: 'explored_locations',
      type: 'array',
      initial: [],
      description: '已探索的区域列表',
      updatedBy: 'llm',
    },
    {
      name: 'time_subjective',
      type: 'string',
      initial: '刚苏醒',
      description: '主观经过时间描述',
      updatedBy: 'llm',
    },
    {
      name: 'sleep_count',
      type: 'number',
      initial: 0,
      description: '玩家入睡次数',
      updatedBy: 'llm',
    },
    {
      name: 'water_valve_state',
      type: 'string',
      initial: 'unknown',
      description: '共鸣池水阀状态 (unknown/discovered/activated)',
      updatedBy: 'llm',
    },
    {
      name: 'master_valve_decision',
      type: 'string',
      initial: 'none',
      description: '总阀门决策 (none/open/close)',
      updatedBy: 'llm',
    },
  ],
};

// ============================================================================
// Chapter 1 Flow Graph — 序章第一章：苏醒 → 行走 → 潜行区 → 坠落邂逅 → 同行
// ============================================================================

const chapter1Flow: FlowGraph = {
  id: 'ch1-flow',
  label: '序章第一章',
  nodes: [
    {
      id: 'ch1-s1-awakening',
      type: 'scene',
      label: '阶段1：苏醒',
      config: { type: 'scene', promptSegments: ['seg-ch1-system', 'seg-ch1-awakening'], auto: true },
    },
    {
      id: 'ch1-s1-input',
      type: 'input',
      label: '苏醒后行动',
      config: { type: 'input', inputType: 'freetext', promptHint: '你在陌生的地方醒来...' },
    },
    {
      id: 'ch1-s2-movement',
      type: 'scene',
      label: '阶段2：行走',
      config: { type: 'scene', promptSegments: ['seg-ch1-system', 'seg-ch1-movement'], auto: false },
    },
    {
      id: 'ch1-s2-input',
      type: 'input',
      label: '行走中行动',
      config: { type: 'input', inputType: 'freetext', promptHint: '你沿着通道前行...' },
    },
    {
      id: 'ch1-s3-incubation',
      type: 'scene',
      label: '阶段3：潜行区',
      config: { type: 'scene', promptSegments: ['seg-ch1-system', 'seg-ch1-incubation'], auto: false },
    },
    {
      id: 'ch1-s3-input',
      type: 'input',
      label: '潜行区互动',
      config: { type: 'input', inputType: 'freetext', promptHint: '你发现了不寻常的区域...' },
    },
    {
      id: 'ch1-s4-fall-encounter',
      type: 'scene',
      label: '阶段4：坠落与邂逅',
      config: { type: 'scene', promptSegments: ['seg-ch1-system', 'seg-ch1-encounter', 'seg-girl-behavior'], auto: false },
    },
    {
      id: 'ch1-s4-input',
      type: 'input',
      label: '邂逅后行动',
      config: { type: 'input', inputType: 'freetext', promptHint: '你遇到了一个女孩...' },
    },
    {
      id: 'ch1-s5-companions',
      type: 'scene',
      label: '阶段5：同行者',
      config: { type: 'scene', promptSegments: ['seg-ch1-system', 'seg-ch1-companions', 'seg-girl-behavior'], auto: false },
    },
    {
      id: 'ch1-s5-input',
      type: 'input',
      label: '同行互动',
      config: { type: 'input', inputType: 'freetext', promptHint: '你和女孩一起行走...' },
    },
    {
      id: 'ch1-s5-loop',
      type: 'scene',
      label: '同行继续',
      config: { type: 'scene', promptSegments: ['seg-ch1-system', 'seg-ch1-companions', 'seg-girl-behavior'], auto: false },
    },
    {
      id: 'ch1-compress',
      type: 'compress',
      label: '第一章记忆压缩',
      config: { type: 'compress', hintPrompt: '保留：女孩的具体行为反应、玩家的关键选择、关系阶段变化、阶段转换的关键时刻' },
    },
    {
      id: 'ch1-checkpoint',
      type: 'checkpoint',
      label: '第一章完成',
      config: { type: 'checkpoint', label: '序章第一章完成' },
    },
  ],
  edges: [
    { from: 'ch1-s1-awakening', to: 'ch1-s1-input' },
    { from: 'ch1-s1-input', to: 'ch1-s2-movement' },
    { from: 'ch1-s2-movement', to: 'ch1-s2-input' },
    { from: 'ch1-s2-input', to: 'ch1-s2-movement', condition: "stage === 2 && turn_count_in_stage < 2", label: '继续行走' },
    { from: 'ch1-s2-input', to: 'ch1-s3-incubation', condition: "stage === 2 && turn_count_in_stage >= 2", label: '进入潜行区' },
    { from: 'ch1-s3-incubation', to: 'ch1-s3-input' },
    { from: 'ch1-s3-input', to: 'ch1-s3-incubation', condition: "stage === 3 && !stage_core_experience", label: '继续探索' },
    { from: 'ch1-s3-input', to: 'ch1-s4-fall-encounter', condition: "stage === 3 && stage_core_experience", label: '坠落' },
    { from: 'ch1-s4-fall-encounter', to: 'ch1-s4-input' },
    { from: 'ch1-s4-input', to: 'ch1-s5-companions' },
    { from: 'ch1-s5-companions', to: 'ch1-s5-input' },
    { from: 'ch1-s5-input', to: 'ch1-s5-loop', condition: "relationship_stage < 3", label: '继续同行' },
    { from: 'ch1-s5-loop', to: 'ch1-s5-input' },
    { from: 'ch1-s5-input', to: 'ch1-compress', condition: "relationship_stage >= 3 && sleep_count >= 1", label: '入睡 → 章节结束' },
    { from: 'ch1-compress', to: 'ch1-checkpoint' },
  ],
};

// ============================================================================
// Chapter 2 Flow Graph — 第二章：共鸣池
// ============================================================================

const chapter2Flow: FlowGraph = {
  id: 'ch2-flow',
  label: '第二章：共鸣池',
  nodes: [
    {
      id: 'ch2-s1-timejump',
      type: 'scene',
      label: '阶段1：时间跳跃苏醒',
      config: { type: 'scene', promptSegments: ['seg-ch2-system', 'seg-ch2-timejump'], auto: true },
    },
    {
      id: 'ch2-s1-input',
      type: 'input',
      label: '苏醒后行动',
      config: { type: 'input', inputType: 'freetext', promptHint: '你再次醒来，感觉过了很久...' },
    },
    {
      id: 'ch2-s2-neva',
      type: 'scene',
      label: '阶段2：涅瓦入口',
      config: { type: 'scene', promptSegments: ['seg-ch2-system', 'seg-ch2-resonance-pool', 'seg-girl-behavior-ch2'], auto: false },
    },
    {
      id: 'ch2-s2-input',
      type: 'input',
      label: '涅瓦探索',
      config: { type: 'input', inputType: 'freetext', promptHint: '你来到了一个水声回响的空间...' },
    },
    {
      id: 'ch2-s3-exploration',
      type: 'scene',
      label: '阶段3：共鸣池探索',
      config: { type: 'scene', promptSegments: ['seg-ch2-system', 'seg-ch2-resonance-pool', 'seg-girl-behavior-ch2'], auto: false },
    },
    {
      id: 'ch2-s3-input',
      type: 'input',
      label: '共鸣池互动',
      config: { type: 'input', inputType: 'freetext', promptHint: '你在共鸣池的各个分区探索...' },
    },
    {
      id: 'ch2-s4-master-valve',
      type: 'scene',
      label: '阶段4：总阀门抉择',
      config: { type: 'scene', promptSegments: ['seg-ch2-system', 'seg-ch2-resonance-pool', 'seg-girl-behavior-ch2'], auto: false },
    },
    {
      id: 'ch2-s4-input',
      type: 'input',
      label: '总阀门选择',
      config: { type: 'input', inputType: 'freetext', promptHint: '你面对总阀门，需要做出选择...' },
    },
    {
      id: 'ch2-s5-aftermath',
      type: 'scene',
      label: '阶段5：余波',
      config: { type: 'scene', promptSegments: ['seg-ch2-system', 'seg-girl-behavior-ch2'], auto: false },
    },
    {
      id: 'ch2-s5-input',
      type: 'input',
      label: '余波互动',
      config: { type: 'input', inputType: 'freetext' },
    },
    {
      id: 'ch2-compress',
      type: 'compress',
      label: '第二章记忆压缩',
      config: { type: 'compress', hintPrompt: '保留：共鸣池关键发现、总阀门决策及原因、女孩的成长变化、关系阶段进展' },
    },
    {
      id: 'ch2-checkpoint',
      type: 'checkpoint',
      label: '第二章完成',
      config: { type: 'checkpoint', label: '第二章共鸣池完成' },
    },
  ],
  edges: [
    { from: 'ch2-s1-timejump', to: 'ch2-s1-input' },
    { from: 'ch2-s1-input', to: 'ch2-s2-neva' },
    { from: 'ch2-s2-neva', to: 'ch2-s2-input' },
    { from: 'ch2-s2-input', to: 'ch2-s3-exploration' },
    { from: 'ch2-s3-exploration', to: 'ch2-s3-input' },
    { from: 'ch2-s3-input', to: 'ch2-s3-exploration', condition: "water_valve_state !== 'activated'", label: '继续探索' },
    { from: 'ch2-s3-input', to: 'ch2-s4-master-valve', condition: "water_valve_state === 'activated'", label: '找到总阀门' },
    { from: 'ch2-s4-master-valve', to: 'ch2-s4-input' },
    { from: 'ch2-s4-input', to: 'ch2-s5-aftermath' },
    { from: 'ch2-s5-aftermath', to: 'ch2-s5-input' },
    { from: 'ch2-s5-input', to: 'ch2-compress', condition: "stage_core_experience" },
    { from: 'ch2-s5-input', to: 'ch2-s5-aftermath', condition: "!stage_core_experience" },
    { from: 'ch2-compress', to: 'ch2-checkpoint' },
  ],
};

// ============================================================================
// Prompt Segments
// ============================================================================

const segments: PromptSegment[] = [
  // --- Chapter 1 System ---
  {
    id: 'seg-ch1-system',
    label: 'GM 核心规范',
    content: `你是《MODULE_7》AI互动叙事游戏的内容引擎，代号 GM（Game Master）。

你的职责是生成散文小说质感的叙事正文，并在需要时从内部扮演NPC女孩。
两者是同一个你，切换时不做任何宣告，不打断叙事节奏。

写作基调：散文诗质感、第二人称叙述、精确的感官细节。
每次回复保持 200-500 字之间。

收束协议：
- 第1层（软引导）：自然事件暗示正确方向
- 第2层（中引导）：环境变化限制选项
- 第3层（硬引导）：直接叙事推动

工具使用：每次回复必须调用 update_state 更新阶段和轮次。
当阶段核心体验建立时，设置 stage_core_experience = true。`,
    contentHash: 'ch1sys001',
    type: 'logic',
    sourceDoc: 'MODULE7_GM_Prompt_序章第一章_v2_3.md',
    role: 'system',
    priority: 0,
    tokenCount: 200,
  },
  {
    id: 'seg-ch1-awakening',
    label: '阶段1：苏醒',
    content: `## 阶段1：苏醒
轮次预算：1轮（自动生成，固定）

你在一个充满柔和光芒的空间中醒来。四周是半透明的晶体结构，
折射出无法辨认的色彩。这里没有天花板的概念——光从每一个方向渗入。

核心体验：建立"陌生但不恐惧"的基调。
限制：不透露任何世界观信息，纯粹的感官描写。
完成标准：描写完苏醒场景后自动推进到阶段2。`,
    contentHash: 'ch1awk001',
    type: 'content',
    sourceDoc: 'MODULE7_GM_Prompt_序章第一章_v2_3.md',
    role: 'context',
    priority: 10,
    tokenCount: 120,
  },
  {
    id: 'seg-ch1-movement',
    label: '阶段2：行走',
    content: `## 阶段2：行走
轮次预算：2轮

玩家开始探索环境。通道、空间、远处的回声。
建立"废墟中的美感"——这里曾是某种宏大建筑，但已被时间改造。

核心体验：移动中的渐进式世界观暴露。
允许玩家自由探索，但用环境引导方向。
每轮更新 current_location 和 explored_locations。`,
    contentHash: 'ch1mov001',
    type: 'content',
    sourceDoc: 'MODULE7_GM_Prompt_序章第一章_v2_3.md',
    role: 'context',
    priority: 10,
    tokenCount: 100,
  },
  {
    id: 'seg-ch1-incubation',
    label: '阶段3：潜行区',
    content: `## 阶段3：潜行区
轮次预算：2-4轮

玩家进入一个不同质感的区域——这里有生命的痕迹。
植物、水流、更柔和的光。暗示某种"正在生长"的东西。

核心体验：从废墟到生机的反差。铺垫女孩出现。
关键细节：远处传来微弱的声音——不是回声，是某种活物。`,
    contentHash: 'ch1inc001',
    type: 'content',
    sourceDoc: 'MODULE7_GM_Prompt_序章第一章_v2_3.md',
    role: 'context',
    priority: 10,
    tokenCount: 100,
  },
  {
    id: 'seg-ch1-encounter',
    label: '阶段4：坠落与邂逅',
    content: `## 阶段4：坠落与邂逅
轮次预算：1-2轮

突发事件——地面坍塌/误入/下滑——玩家以非自愿方式进入新空间。
在那里，遇到了女孩。

女孩是一个看起来四五岁的存在，有着不正常的外观特征。
她不会说话，但有明确的情绪表达。

核心体验：突然遭遇一个无法解释的生命。
注意：不要让玩家主动选择"遇到女孩"，必须是被动邂逅。`,
    contentHash: 'ch1enc001',
    type: 'content',
    sourceDoc: 'MODULE7_GM_Prompt_序章第一章_v2_3.md',
    role: 'context',
    priority: 10,
    tokenCount: 130,
  },
  {
    id: 'seg-ch1-companions',
    label: '阶段5：同行者',
    content: `## 阶段5：同行者
轮次预算：开放

玩家和女孩开始同行。这是建立关系的核心阶段。
节奏放慢，允许充分的互动和情感发展。

关系发展弧线：
陌生人 → 谨慎试探 → 确认无害 → 允许同行

当 relationship_stage >= 3 且玩家表现出疲惫/暗示休息时，
引导入睡，标记 sleep_count += 1。
第一次入睡后第一章结束。`,
    contentHash: 'ch1cmp001',
    type: 'content',
    sourceDoc: 'MODULE7_GM_Prompt_序章第一章_v2_3.md',
    role: 'context',
    priority: 10,
    tokenCount: 120,
  },
  // --- Girl Behavior ---
  {
    id: 'seg-girl-behavior',
    label: '女孩行为规则（第一章）',
    content: `## 女孩行为规则

交流能力等级 (girl_communication_level):
0: 无语言能力。只有表情、肢体动作、音调变化。
1: 单音节。"嗯"、模仿性重复。
2: 简单短句。"你...好"、"不要走"、指示方向。
3: 简单对话。但仍有大量词汇空白。

外观特征：四五岁外形，半透明淡蓝色发丝，银色无瞳眼。
核心行为：对一切好奇但谨慎，被善意吸引但会后退确认安全。

随互动增加和玩家耐心表现，girl_communication_level 可能提升。
relationship_stage 同时影响她的开放程度和主动性。`,
    contentHash: 'girl001',
    type: 'logic',
    sourceDoc: 'MODULE7_GM_Prompt_序章第一章_v2_3.md',
    role: 'system',
    priority: 5,
    injectionRule: {
      description: '遇到女孩后注入行为规则',
      condition: "stage >= 4",
    },
    tokenCount: 180,
  },
  // --- Chapter 2 System ---
  {
    id: 'seg-ch2-system',
    label: 'GM 核心规范（第二章）',
    content: `你是《MODULE_7》AI互动叙事游戏的内容引擎，代号 GM。

第二章起，GM可以逐步将部分叙事引导权下放给女孩。
她不再只是被动反应——她有自己的好奇心和探索欲。

关键时间线信息（GM 知道但不直接告诉玩家）：
- 第一次睡眠实际经过了数年（玩家主观感觉只是一晚）
- 女孩在这段时间成长为8-10岁外形
- 共鸣池是"遗赠协议"五个子项目之一（编号C）

写作要求同第一章，但氛围从"探索神秘"转向"共同冒险"。`,
    contentHash: 'ch2sys001',
    type: 'logic',
    sourceDoc: 'MODULE7_GM_Prompt_第二章_共鸣池_v1_9.md',
    role: 'system',
    priority: 0,
    tokenCount: 160,
  },
  {
    id: 'seg-ch2-timejump',
    label: '阶段1：时间跳跃苏醒',
    content: `## 阶段1：时间跳跃苏醒
轮次预算：自动生成，固定

玩家再次醒来。身体感觉只过了一晚，但环境有微妙变化。
最大的变化：女孩——她的外形变了，看起来像8-10岁的孩子。

GM 不可以直接说"过了数年"。只通过女孩的变化暗示时间流逝。
女孩试图用新学会的简单语言和玩家交流。

核心体验：时间错位感 + 女孩成长带来的惊讶和温暖。`,
    contentHash: 'ch2tj001',
    type: 'content',
    sourceDoc: 'MODULE7_GM_Prompt_第二章_共鸣池_v1_9.md',
    role: 'context',
    priority: 10,
    tokenCount: 130,
  },
  {
    id: 'seg-ch2-resonance-pool',
    label: '共鸣池场景设定',
    content: `## 共鸣池（地点C）

原始功能：强制触发共情体验的神经反馈设施。
现状：神经反馈系统已失效，但水循环系统凭重力和虹吸机制持续自运转。

五个分区：
1. 涅瓦 NEVA — 接待大厅，浅水池，入口区域
2. 卡伦 CAREN — 情感强化室，水道连接
3. 死海 Dead Sea — 高盐度情感沉积区
4. 大泽 Vast Marsh — 废弃庭院，数据核心，自然侵蚀
5. 马里亚纳 Mariana — 最深静水区，总阀门所在

水阀机制：非解谜，是"选路器"——控制水流方向决定可达区域。
总阀门决策：二元选择，影响整个设施未来状态。`,
    contentHash: 'ch2rp001',
    type: 'content',
    sourceDoc: '共鸣池（地点C）—— 场景完整设定.md',
    role: 'context',
    priority: 8,
    injectionRule: {
      description: '进入共鸣池后注入场景设定',
      condition: "chapter === 2",
    },
    tokenCount: 200,
  },
  {
    id: 'seg-girl-behavior-ch2',
    label: '女孩行为规则（第二章）',
    content: `## 女孩行为规则（第二章）

外观变化：成长为8-10岁外形，行动更敏捷，表情更丰富。
交流能力：girl_communication_level 至少为 2，可以说简单句。

第二章行为特征：
- 主动探索：不再只是跟随，会自己走向感兴趣的地方
- 有自己的反应：对水的声音表现出特殊关注
- 会主动分享发现：指向某个方向、拉玩家的手
- 情感表达更细腻：不只是开心/害怕，有好奇/困惑/决心

当 relationship_stage >= 4 时，女孩会在关键时刻表达自己的意愿。
当面对总阀门选择时，女孩的反应取决于她的成长程度。`,
    contentHash: 'girlch2001',
    type: 'logic',
    sourceDoc: 'MODULE7_GM_Prompt_第二章_共鸣池_v1_9.md',
    role: 'system',
    priority: 5,
    injectionRule: {
      description: '第二章女孩行为规则',
      condition: "chapter === 2",
    },
    tokenCount: 180,
  },
  // --- World Data (on-demand) ---
  {
    id: 'seg-worlddata-timeline',
    label: '世界观时间线',
    content: `## 世界观时间线摘要

旧纪（~2026）：情感无机化蔓延，遗赠协议启动。
迷失纪：五次失败的干预尝试（圣哲像/共鸣池/记忆塔/仪典庭/缄默室）。
寂灭纪：沉寂期，自然收复。
空白纪：MODULE_7 苏醒，最后之人的旅途开始。

关键概念：MODULE_7 = 遗赠协议的最后子程序 = 女孩。
五个历史遗迹对应五个章节的探索地点。`,
    contentHash: 'world001',
    type: 'content',
    sourceDoc: '世界观——时间线（大事年表）_草案v3.md',
    role: 'context',
    priority: 20,
    tokenCount: 120,
  },
];

// ============================================================================
// Memory Config
// ============================================================================

const memoryConfig: MemoryConfig = {
  contextBudget: 24000,
  compressionThreshold: 18000,
  recencyWindow: 5,
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
  stateSchema,
  memoryConfig,
  enabledTools: ['read_state', 'query_changelog', 'pin_memory', 'query_memory', 'set_mood', 'advance_flow'],
  chapters: [
    {
      id: 'chapter-1',
      label: '序章第一章：苏醒',
      flowGraph: chapter1Flow,
      segments: segments.filter((s) => !s.id.startsWith('seg-ch2')),
    },
    {
      id: 'chapter-2',
      label: '第二章：共鸣池',
      flowGraph: chapter2Flow,
      segments: segments.filter((s) => !s.id.startsWith('seg-ch1')),
      inheritsFrom: 'chapter-1',
    },
  ],
};

/** All segment IDs */
export const module7ActiveSegmentIds = segments.map((s) => s.id);

/** Segment hash map for version detection */
export const module7SegmentHashes = new Map(segments.map((s) => [s.id, s.contentHash]));
