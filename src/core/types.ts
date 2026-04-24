/**
 * Interactive Novel Engine v2.0 — Core Type Definitions
 *
 * All IR (Intermediate Representation) interfaces and runtime state types.
 * This file is the single source of truth for data structures across the engine.
 */

// ============================================================================
// LLM Provider Config — LLM 提供商配置（core 统一接口）
// ============================================================================

/** 支持的 provider 协议 */
export type LLMProviderType = 'openai-compatible' | 'anthropic';

/** 单个模型端点配置 */
export interface ModelEndpoint {
  provider: LLMProviderType;
  baseUrl: string;
  apiKey: string;
  model: string;
  name?: string;                    // 显示名称
}

/** 引擎所需的完整 LLM 配置——文本生成 + 向量嵌入 */
export interface ProviderConfig {
  text: ModelEndpoint;              // 文本生成模型（必需）
  embedding?: ModelEndpoint;        // 向量嵌入模型（可选，记忆模块用）
}

// ============================================================================
// Flow Graph — 场景流程图（可视化参考，不做运行时路由）
// ============================================================================

export interface FlowGraph {
  id: string;
  label: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface FlowNode {
  id: string;
  label: string;
  description?: string;
  promptSegments: string[];   // 引用的 PromptSegment ID 列表
}

export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
}

// ============================================================================
// Prompt Segments — 拆分后的 Prompt 片段
// ============================================================================

export type SegmentType = 'content' | 'logic';
export type SegmentRole = 'system' | 'context' | 'draft';

export interface PromptSegment {
  id: string;
  label: string;
  content: string;
  contentHash: string;
  type: SegmentType;
  sourceDoc: string;
  sourceRange?: [number, number];
  role: SegmentRole;
  priority: number;           // 组装时的优先级（数字越小优先级越高）
  assemblyOrder?: number;     // 组装顺序（用于 prompt 前缀缓存优化，越小越前）
  injectionRule?: InjectionRule;
  /**
   * Focus Injection 标签（见 src/core/focus.ts 和 .claude/plans/focus-injection.md）
   * 运行时用来匹配当前 focus（scene / chars / stage），排到 _engine_scene_context
   * section 里作为"最相关 segments"提示 LLM 重点关注。
   * MVP 只消费 scene 字段；chars / stage 先预留不使用。
   */
  focusTags?: FocusTags;
  tokenCount: number;
  /** LLM 改写后的衍生内容（仅 system segment 可用） */
  derivedContent?: string;
  /** 组装时使用衍生版本还是原文 */
  useDerived?: boolean;
}

/**
 * Focus Injection 标签结构。每个字段都是可选 —— 空值等于"对该维度无要求"，
 * 不参与该维度的匹配（但其他维度仍参与）。
 */
export interface FocusTags {
  scene?: string;
  chars?: string[];   // v2 用
  stage?: string;     // v2 用
}

/**
 * 当前 focus 状态，由 computeFocus(stateVars) 运行时推断。
 * MVP 只读 scene；v2 扩展 characters 和 stage。
 */
export interface FocusState {
  scene?: string;
  characters?: string[];
  stage?: string;
}

export interface InjectionRule {
  description: string;        // 自然语言描述，编剧可见
  condition: string;          // 编译后的条件表达式
}

// ============================================================================
// State Schema — 状态变量定义
// ============================================================================

export type StateVariableType = 'number' | 'string' | 'boolean' | 'array' | 'object';

export interface StateSchema {
  variables: StateVariable[];
}

export interface StateVariable {
  name: string;
  type: StateVariableType;
  initial: unknown;
  description: string;
  range?: { min?: number; max?: number };
}

// ============================================================================
// Memory Config — 记忆策略配置
// ============================================================================

export interface MemoryConfig {
  contextBudget: number;          // token 总预算
  compressionThreshold: number;   // 触发压缩的 token 阈值
  recencyWindow: number;          // 保留最近 N 条原文
  compressionHints?: string;      // 自然语言的压缩指导

  /**
   * Memory adapter 选择（见 src/core/memory/factory.ts）
   * - 'legacy'（默认）：原 MemoryManager 等价行为，截断拼接式"压缩"
   * - 'llm-summarizer'（Phase 2）：真 LLM 摘要
   * - 'mem0'（Phase 3）：mem0 托管向量检索
   */
  provider?: 'legacy' | 'llm-summarizer' | 'mem0';

  /** Adapter 特定参数（mem0 的 topK / filter 等，Phase 3 定义） */
  providerOptions?: Record<string, unknown>;
}

// ============================================================================
// Script Manifest — 剧本清单（IR 的顶层容器）
// ============================================================================

export interface ScriptManifest {
  id: string;
  label: string;
  chapters: ChapterManifest[];
  stateSchema: StateSchema;
  memoryConfig: MemoryConfig;
  enabledTools: string[];         // 启用的可选工具 ID 列表
  initialPrompt?: string;         // 首轮 user message（等效于 prompt.txt）
  /**
   * 视觉 IR 协议版本（RFC-声明式视觉IR_2026-04-24）。
   *   - 'v1-tool-call'（默认 / 缺省）：change_scene / change_sprite / clear_stage
   *     工具调用 + XML-lite（<d>/<n>）叙事解析。老 parser（v1 NarrativeParser）。
   *   - 'v2-declarative-visual'：嵌套 XML 声明式视觉（<dialogue>/<narration>/
   *     <scratch> + 子 <background/>/<sprite/>/<stage/>）。新 parser（
   *     src/core/narrative-parser-v2）。视觉 tools 不启用。
   * 两种协议的 playthrough 共存：session 启动时按此字段分叉 parser，v1 老
   * playthrough 不受影响（RFC §6）。
   */
  protocolVersion?: 'v1-tool-call' | 'v2-declarative-visual';
  // --- 展示字段 ---
  coverImage?: string;            // 封面图 URL
  description?: string;           // 简介
  author?: string;                // 作者
  tags?: string[];                // 分类标签
  openingMessages?: string[];     // 进入对话页后的静态开场消息（不经过 LLM）
  // --- 组装顺序 ---
  /** Prompt 组装顺序：section ID 列表，决定各部分在 prompt 中的排列位置 */
  promptAssemblyOrder?: string[];
  /** 被禁用的 section ID 列表（不参与组装） */
  disabledAssemblySections?: string[];
  // --- VN 资产引用（M3 起，optional 保持向后兼容）---
  /** 剧本中出现的角色及其立绘资源 */
  characters?: CharacterAsset[];
  /** 剧本中出现的背景资源 */
  backgrounds?: BackgroundAsset[];
  /** 剧本开场的默认场景（玩家首次开始时的 currentScene 初值） */
  defaultScene?: SceneState;
}

/** 首页卡片用的轻量目录条目 */
export interface ScriptCatalogEntry {
  id: string;
  label: string;
  coverImage?: string;
  description?: string;
  author?: string;
  tags?: string[];
  chapterCount: number;
}

export interface ChapterManifest {
  id: string;
  label: string;
  flowGraph: FlowGraph;
  segments: PromptSegment[];
  inheritsFrom?: string;          // 上一章 ID
}

// ============================================================================
// Runtime State
// ============================================================================

// 注：旧版的 ProgressState（Layer 1，含 currentChapterId / totalTurns /
// inputNeeded / activeSegmentIds / scriptVersion）已随 v2.5 后端持久化上线
// 而废弃 —— 相应数据现在都在 playthroughs 表里维护，前端不再需要一个独立
// 的 Layer 1 interface。删除时间：2026-04-11。

// ScriptState — 编剧定义的游戏变量
export interface ScriptState {
  vars: Record<string, unknown>;
}

// Layer 3: Memory — 记忆
export interface MemoryEntry {
  id: string;
  turn: number;
  role: 'generate' | 'receive' | 'system';
  content: string;
  tokenCount: number;
  timestamp: number;
  tags?: string[];
  pinned?: boolean;
}

// MemoryState 已删除 —— 新实现用 Memory / MemorySnapshot（opaque JSON）表示记忆状态。
// 老字段 inheritedSummary（章节继承）和 watermark（未被任何 hot path 使用）一并去除。

// Layer 4: Runtime — 临时执行状态（不持久化）
export interface RuntimeState {
  status: 'idle' | 'executing' | 'waiting-input' | 'compressing' | 'error';
  streamBuffer?: string;
  lastTokenUsage?: TokenUsage;
  error?: EngineError;
}

export interface TokenUsage {
  system: number;
  history: number;
  summary: number;
  output: number;
  total: number;
  budget: number;
}

export interface EngineError {
  message: string;
  recoverable: boolean;
}

// ============================================================================
// Changelog — 状态变更历史（独立存储）
// ============================================================================

export interface ChangelogEntry {
  id: string;
  turn: number;
  timestamp: number;
  key: string;
  previousValue: unknown;
  newValue: unknown;
  source: 'llm' | 'system';
}

export interface ChangelogFilter {
  key?: string;
  turnRange?: [number, number];
  timeRange?: [number, number];
  source?: ChangelogEntry['source'];
}

// 跨章继承（InheritanceSnapshot / CrossChapterConfig / chapter-transition.ts）
// 已整体删除：原实现从未被任何 caller 触发，记忆模块重构中又确认章节不是
// memory 生命周期事件。未来若真要做章节边界，重新设计比接通这个骨架更干净。

// ============================================================================
// Tool System — Agentic 工具系统
// ============================================================================

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;  // JSON Schema
  required: boolean;                     // true = 必选工具, false = 可选工具
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCallResult {
  id: string;
  name: string;
  result: unknown;
  error?: string;
}

// 注：旧版的 SaveData（IndexedDB 存档结构）已随 v2.5 后端 playthroughs
// 持久化上线而废弃。相应数据在 playthroughs + narrative_entries 两张表
// 里，前端不再需要这个类型。删除时间：2026-04-11。

// ============================================================================
// Segment Activation — Segment 激活状态管理
// ============================================================================

export interface SegmentChangeReport {
  segmentId: string;
  label: string;
  type: SegmentType;
  changeKind: 'content-changed' | 'added' | 'removed';
}

export interface ScriptVersionDiff {
  fromVersion: string;
  toVersion: string;
  changes: SegmentChangeReport[];
  logicSegmentsChanged: boolean;      // 是否有 logic 类型 segment 变化
}

// ============================================================================
// Session Types — 跨层共享的运行时类型
// ============================================================================

export interface NarrativeEntry {
  id: string;
  role: 'generate' | 'receive' | 'system';
  content: string;
  reasoning?: string;
  toolCalls?: ToolCallEntry[];
  promptSnapshot?: PromptSnapshot;
  finishReason?: string;
  timestamp: number;
  /** true = LLM 正在流式生成此条目。false/undefined = 已完成。 */
  streaming?: boolean;
}

export interface PromptSnapshot {
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
  tokenBreakdown: TokenBreakdownInfo;
  activeSegmentIds: string[];
}

export interface ToolCallEntry {
  name: string;
  args: unknown;
  result: unknown;
  timestamp: number;
}

export interface TokenBreakdownInfo {
  system: number;
  state: number;
  summaries: number;
  recentHistory: number;
  contextSegments: number;
  total: number;
  budget: number;
}

// ============================================================================
// VN Narrative — XML-lite 叙事协议产出的结构化类型（M3）
// ============================================================================

/**
 * 立绘在场景中的呈现。
 * id / emotion 是剧本 manifest 里定义的 character + sprite id（snake_case）。
 * position 是可选的视觉位置，省略由前端决定默认布局。
 */
export interface SpriteState {
  id: string;                          // 角色 id（如 "aonkei"）
  emotion: string;                     // 表情 id（如 "praying" / "determined"）
  position?: 'left' | 'center' | 'right';
}

/**
 * 一帧场景的快照。由 change_scene / change_sprite / clear_stage 工具演进。
 * 每个 Sentence 都 carry 一个 sceneRef 快照，backlog 回看时能正确还原视觉。
 */
export interface SceneState {
  background: string | null;           // 背景 id；null = 无背景（纯色或 gradient）
  sprites: SpriteState[];              // 在场的立绘，顺序即默认渲染顺序
}

/**
 * Goffman 参与框架（Participation Framework）。
 * 由 XML-lite 标签 <d s="..." to="..." hear="..." eav="..."> 解析而来。
 *
 * 参考：main 分支 `参与框架.md` AD-7~AD-10 决策。
 *
 * - speaker: 发话者 id（必填）
 * - addressee: 受话者 id 列表（省略 = 独白，用 ['*'] 表示广播）
 * - overhearers: 明知旁听者（speaker 知道他们在场）
 * - eavesdroppers: 偷听者（speaker 不知道他们在场）
 */
export interface ParticipationFrame {
  speaker: string;
  addressee?: string[];                // 省略 = 独白/内心
  overhearers?: string[];
  eavesdroppers?: string[];
}

/**
 * 叙事流的单个句子。由 streaming narrative parser 产出。
 * 作为前端 VN UI + 记忆投影的共同数据源（"单一 map 函数"原则）。
 *
 * truncated 标记：streaming 结束时 parser 末尾降级闭合产生的 dialogue，
 * 说明 LLM 输出被 maxOutputTokens 截断。Langfuse 会记录这种事件。
 *
 * v2（声明式视觉 IR，RFC 2026-04-24）起新增可选字段 bgChanged / spritesChanged：
 *   resolvedScene（= sceneRef）相对前一 Sentence 是否变了背景 / 立绘栈。
 *   v1 parser 不填；v2 parser 根据继承规则计算。UI / tracing 用这两个 bool
 *   避免重复比较对象。字段缺省 = 未知 / 沿用旧行为。
 */
export type Sentence =
  | {
      kind: 'narration';
      text: string;
      sceneRef: SceneState;
      turnNumber: number;
      index: number;                   // 在 playthrough 内的全局序号
      bgChanged?: boolean;
      spritesChanged?: boolean;
      truncated?: boolean;             // v2：未闭合被强制 close
    }
  | {
      kind: 'dialogue';
      text: string;
      pf: ParticipationFrame;
      sceneRef: SceneState;
      turnNumber: number;
      index: number;
      truncated?: boolean;             // parser 末尾降级闭合的标记
      bgChanged?: boolean;
      spritesChanged?: boolean;
    }
  | {
      kind: 'scene_change';
      scene: SceneState;
      transition?: 'fade' | 'cut' | 'dissolve';
      turnNumber: number;
      index: number;
    }
  | {
      /**
       * signal_input_needed 被 LLM 调用的一次事件（migration 0010）。
       * 在 backlog 里渲染成"📍 GM 问了 X，给了选项 [A, B, C]"，玩家之后的
       * player_input Sentence 的 selectedIndex 会高亮对应选项。
       *
       * 对话框里**不占 click**（和 scene_change 同级，advanceSentence 自动跳过），
       * 因为 live 交互由 game-store.choices 驱动的选项面板承担。
       */
      kind: 'signal_input';
      hint: string;
      choices: string[];
      sceneRef: SceneState;
      turnNumber: number;
      index: number;
    }
  | {
      /**
       * 玩家的输入（signal_input_needed 里选的选项 / 自由输入）。
       * VN UI 会把它以"玩家回复气泡"形式显示在 backlog + 对话框里。
       * 由 game-session.submitInput 触发 appendSentence，而不是来自 LLM。
       *
       * selectedIndex（migration 0010）：如果玩家从 signal_input 的 choices 里
       * 选了一个，保存 0-based 下标；自由输入时 undefined。供 backlog 对照前置
       * signal_input Sentence 的 choices 数组高亮显示。
       */
      kind: 'player_input';
      text: string;
      selectedIndex?: number;
      sceneRef: SceneState;
      turnNumber: number;
      index: number;
    };

// ============================================================================
// Script Assets — 剧本美术资产引用（M3 起；M4 接入 OSS 完整上传链路）
// ============================================================================

/** 一个立绘资源 */
export interface SpriteAsset {
  id: string;                          // 表情 id（"praying" / "smiling"）
  assetUrl?: string;                   // M3 可空，M4 填 OSS URL
  label?: string;                      // 可选人读描述
}

/** 一个角色的所有立绘 */
export interface CharacterAsset {
  id: string;                          // snake_case（"aonkei"）
  displayName: string;                 // UI 呈现名（"昂晴"）
  sprites: SpriteAsset[];
}

/** 一个背景资源 */
export interface BackgroundAsset {
  id: string;                          // "classroom_evening"
  assetUrl?: string;                   // M3 可空
  label?: string;
}

// ============================================================================
// Scratch Block — LLM 元叙述 / 内部思考出口（RFC v2 原则 #6 / §3.1）
// ============================================================================

/**
 * `<scratch>` 顶层容器的一次产出。不渲染给玩家、不产生 Sentence，
 * 但保留在下一轮 messages-builder 的 assistant 历史里（in-context 强化）。
 *
 * 用途：承接 LLM 的计划 / 思考 / 元叙述（"让我先 read_state..."），
 * 让 parser 有法可依，不污染 <narration>。
 *
 * tracing：每次 close tag 产出一个 ScratchBlock，Langfuse 事件名 `ir-scratch`
 * （非 degrade，按正常事件统计）。
 */
export interface ScratchBlock {
  /** `<scratch>` 内部累计的纯文本（已 trim 首尾空白） */
  text: string;
  /** 本次 turn 编号，供 tracing 关联当前 generate() 回合 */
  turnNumber: number;
  /** 在 playthrough 内的全局序号（与 Sentence.index 共享同一计数器） */
  index: number;
}
