/**
 * Architect Agent Types
 *
 * Types shared across all architect sub-agents.
 */

import type {
  FlowGraph,
  PromptSegment,
  InjectionRule,
  StateSchema,
  MemoryConfig,
  CrossChapterConfig,
} from '../types';

// ============================================================================
// Document Classification (Step 2.1)
// ============================================================================

export type DocumentRole =
  | 'gm_prompt'       // GM 提示词（核心文档）
  | 'pc_prompt'        // PC 提示词
  | 'world_data'       // 世界观资料
  | 'location_data'    // 场景/地点设定
  | 'character_data'   // 角色设定
  | 'rules'            // 游戏规则/机制说明
  | 'other';           // 其他

export interface UploadedDocument {
  id: string;
  filename: string;
  content: string;
  role: DocumentRole;
  chapter?: string;          // 关联章节 ID（如有）
  tokenCount: number;
}

export interface ClassificationResult {
  documentId: string;
  role: DocumentRole;
  chapter?: string;
  confidence: number;        // 0-1
  reasoning: string;         // 分类理由
}

// ============================================================================
// Agent Extraction Results (Steps 2.2–2.7)
// ============================================================================

export interface StateExtractionResult {
  schema: StateSchema;
  reasoning: string;
}

export interface FlowExtractionResult {
  graph: FlowGraph;
  reasoning: string;
}

export interface PromptSplitResult {
  segments: PromptSegment[];
  reasoning: string;
}

export interface InjectionRuleResult {
  rules: InjectionRule[];
  reasoning: string;
}

export interface ToolEnablementResult {
  enabledOptionalTools: string[];
  updateStateSchema: Record<string, unknown>;   // JSON Schema for update_state params
  reasoning: string;
}

export interface MemoryStrategyResult {
  config: MemoryConfig;
  crossChapter?: CrossChapterConfig;
  reasoning: string;
}

// ============================================================================
// Pipeline
// ============================================================================

/** Full result of the Architect Agent pipeline */
export interface ArchitectResult {
  documents: UploadedDocument[];
  classification: ClassificationResult[];
  stateExtraction: StateExtractionResult;
  flowExtraction: FlowExtractionResult;
  promptSplit: PromptSplitResult;
  injectionRules: InjectionRuleResult;
  toolEnablement: ToolEnablementResult;
  memoryStrategy: MemoryStrategyResult;
}

/** Callback for streaming agent progress to UI */
export type AgentProgressCallback = (step: string, message: string) => void;
