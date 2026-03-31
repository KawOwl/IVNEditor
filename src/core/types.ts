/**
 * Interactive Novel Engine v2.0 — Core Type Definitions
 *
 * All IR (Intermediate Representation) interfaces and runtime state types.
 * This file is the single source of truth for data structures across the engine.
 */

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
export type SegmentRole = 'system' | 'context';

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
  injectionRule?: InjectionRule;
  tokenCount: number;
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
  version: string;                // 剧本版本号
  label: string;
  chapters: ChapterManifest[];
  stateSchema: StateSchema;
  memoryConfig: MemoryConfig;
  enabledTools: string[];         // 启用的可选工具 ID 列表
}

export interface ChapterManifest {
  id: string;
  label: string;
  flowGraph: FlowGraph;
  segments: PromptSegment[];
  inheritsFrom?: string;          // 上一章 ID
}

// ============================================================================
// Four-Layer Runtime State — 四层运行时状态
// ============================================================================

// Layer 1: Progress — 流程进度
export interface ProgressState {
  currentChapterId: string;
  totalTurns: number;
  inputNeeded: boolean;
  activeSegmentIds: string[];
  scriptVersion: string;
}

// Layer 2: ScriptState — 编剧定义的游戏变量
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

// ============================================================================
// Save/Load — 存档结构
// ============================================================================

export interface SaveData {
  version: string;
  scriptId: string;
  scriptVersion: string;
  timestamp: number;
  progress: ProgressState;
  scriptState: ScriptState;
  memory: MemoryState;
  changelog: ChangelogEntry[];
  activeSegmentIds: string[];         // 当前激活的 segment ID 列表
  inheritanceSnapshot?: InheritanceSnapshot;
}

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
