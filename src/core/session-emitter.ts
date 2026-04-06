/**
 * SessionEmitter — 引擎运行时与视图层的解耦接口
 *
 * GameSession 通过此接口向外部推送事件，不直接依赖 Zustand 或任何 UI 框架。
 *
 * 实现方式：
 *   - LocalSessionEmitter: 直接写 Zustand store（当前，前端单体）
 *   - 未来：WebSocket/SSE 实现（引擎在后端运行，事件推送到前端）
 */

import type { PromptSnapshot, TokenBreakdownInfo, ToolCallEntry } from './types';

// ============================================================================
// Types
// ============================================================================

export type SessionStatus = 'idle' | 'loading' | 'generating' | 'waiting-input' | 'compressing' | 'error';

export interface DebugSnapshot {
  stateVars?: Record<string, unknown>;
  totalTurns?: number;
  tokenBreakdown?: TokenBreakdownInfo | null;
  memoryEntryCount?: number;
  memorySummaryCount?: number;
  memoryEntries?: Array<{ role: string; content: string; pinned?: boolean }>;
  memorySummaries?: string[];
  changelogEntries?: Array<{ turn: number; key: string; oldValue: unknown; newValue: unknown; source: string }>;
  assembledSystemPrompt?: string | null;
  assembledMessages?: Array<{ role: string; content: string }>;
  activeSegmentIds?: string[];
}

// ============================================================================
// SessionEmitter Interface
// ============================================================================

export interface SessionEmitter {
  // --- Lifecycle ---
  /** Reset all state to initial */
  reset(): void;
  /** Update session status */
  setStatus(status: SessionStatus): void;
  /** Set/clear error message */
  setError(error: string | null): void;

  // --- Streaming ---
  /** 创建一条新的 streaming entry 到 entries[]，返回其 ID */
  beginStreamingEntry(): string;
  /** 向当前 streaming entry 追加叙事文本 */
  appendToStreamingEntry(text: string): void;
  /** 向当前 streaming entry 追加推理文本 */
  appendReasoningToStreamingEntry(reasoning: string): void;
  /** 标记当前 streaming entry 完成，附加调试信息 */
  finalizeStreamingEntry(): void;

  // --- Entries ---
  /** Append a completed narrative entry (e.g., player input) */
  appendEntry(entry: { role: 'generate' | 'receive' | 'system'; content: string }): void;

  // --- Tool calls ---
  /** Record a tool call (global log) */
  addToolCall(entry: Omit<ToolCallEntry, 'timestamp'>): void;
  /** Record a tool call for the current pending entry (debug) */
  addPendingToolCall(entry: Omit<ToolCallEntry, 'timestamp'>): void;
  /** Update tool result in the global log */
  updateToolResult(name: string, result: unknown): void;
  /** Update tool result in the pending entry log */
  updatePendingToolResult(name: string, result: unknown): void;

  // --- Input ---
  /** Set input hint text */
  setInputHint(hint: string | null): void;
  /** Set input type and optional choices */
  setInputType(type: 'freetext' | 'choice', choices?: string[] | null): void;

  // --- Debug ---
  /** Stage debug info that will be attached to the next finalized entry */
  stagePendingDebug(info: { promptSnapshot?: PromptSnapshot; finishReason?: string }): void;
  /** Update debug panel data */
  updateDebug(debug: DebugSnapshot): void;
}
