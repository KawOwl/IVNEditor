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
  tokenCount: number;
  /** LLM 改写后的衍生内容（仅 system segment 可用） */
  derivedContent?: string;
  /** 组装时使用衍生版本还是原文 */
  useDerived?: boolean;
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
  crossChapterInheritance?: CrossChapterConfig;
}

export interface CrossChapterConfig {
  inherit: string[];              // 编剧显式要求继承的字段
  exclude: string[];              // 编剧显式要求不继承的字段
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

export interface MemoryState {
  entries: MemoryEntry[];
  summaries: string[];
  watermark: number;              // 压缩水位线：此序号之前的条目已被压缩
  inheritedSummary?: string;      // 从上一章继承的摘要
}

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

// ============================================================================
// Cross-Chapter Inheritance Snapshot — 跨章继承快照
// ============================================================================

export interface InheritanceSnapshot {
  fromChapter: string;
  toChapter: string;
  timestamp: number;
  fields: Record<string, unknown>;  // 继承的字段及其值
  summary: string;                   // 继承的记忆摘要
}

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
