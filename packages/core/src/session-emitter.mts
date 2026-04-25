/**
 * SessionEmitter — legacy runtime projection target
 *
 * Core session logic emits CoreEvent. This interface is the compatibility
 * target used by CoreEvent projection adapters for WebSocket, tests, and
 * existing UI/debug consumers. New core code should depend on CoreEventSink
 * instead of this method-oriented interface.
 *
 * 典型消费者：
 *   - WebSocketSessionEmitter: 后端运行时把事件序列化给前端
 *   - RecordingSessionEmitter: 测试 / 评测任务直接收集事件快照
 */

import type {
  PromptSnapshot,
  TokenBreakdownInfo,
  ToolCallEntry,
  SceneState,
  Sentence,
} from '#internal/types';

// ============================================================================
// Types
// ============================================================================

export type SessionStatus = 'idle' | 'loading' | 'generating' | 'waiting-input' | 'compressing' | 'error' | 'finished';

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

  // --- VN Scene & Narrative (M3) ---
  /**
   * 一个已产出的 Sentence 追加到 playthrough 的 sentences 序列。
   * VN / ivn-xml / 评测 consumer 消费这个作为推进单元。
   */
  appendSentence(sentence: Sentence): void;
  /**
   * 场景变化（background / sprites）。consumer 用它更新 currentScene。
   * 注：调用顺序和 appendSentence('scene_change') 一致——在发出 Sentence 前先 emit。
   */
  emitSceneChange(scene: SceneState, transition?: 'fade' | 'cut' | 'dissolve'): void;
}
