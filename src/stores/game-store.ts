/**
 * GameStore — Zustand 全局状态管理
 *
 * 连接引擎核心（CoreLoop, LLMClient, etc.）和 UI 层。
 * UI 组件只读取此 store，所有引擎操作通过 actions 触发。
 */

import { create } from 'zustand';

// Session types 定义在 core/types.ts，此处 re-export 供 UI 层使用
export type {
  NarrativeEntry,
  PromptSnapshot,
  ToolCallEntry,
  TokenBreakdownInfo,
} from '../core/types';

import type {
  NarrativeEntry,
  PromptSnapshot,
  ToolCallEntry,
  TokenBreakdownInfo,
} from '../core/types';

// ============================================================================
// Types
// ============================================================================

export interface GameState {
  // --- Session Status ---
  status: 'idle' | 'loading' | 'generating' | 'waiting-input' | 'compressing' | 'error';
  error: string | null;

  // --- Narrative ---
  entries: NarrativeEntry[];
  /** 当前正在流式写入的 entry ID，null = 没有活跃的 streaming */
  streamingEntryId: string | null;

  // --- Pending debug info (attached to next finalized entry) ---
  pendingToolCalls: ToolCallEntry[];
  pendingPromptSnapshot: PromptSnapshot | null;
  pendingFinishReason: string | null;

  // --- Input ---
  inputHint: string | null;    // hint from signal_input_needed
  inputType: 'freetext' | 'choice';
  choices: string[] | null;    // for choice-type input

  // --- Debug ---
  stateVars: Record<string, unknown>;
  totalTurns: number;
  toolCalls: ToolCallEntry[];
  tokenBreakdown: TokenBreakdownInfo | null;
  memoryEntryCount: number;
  memorySummaryCount: number;
  memoryEntries: Array<{ role: string; content: string; pinned?: boolean }>;
  memorySummaries: string[];
  changelogEntries: Array<{ turn: number; key: string; oldValue: unknown; newValue: unknown; source: string }>;
  // --- Assembled Context (for editor debug) ---
  assembledSystemPrompt: string | null;
  assembledMessages: Array<{ role: string; content: string }>;
  activeSegmentIds: string[];

  // --- Actions ---
  appendEntry: (entry: Omit<NarrativeEntry, 'id' | 'timestamp'>) => void;
  /** 创建一条新的 streaming entry，返回其 ID */
  beginStreamingEntry: () => string;
  /** 向当前 streaming entry 追加叙事文本 */
  appendToStreamingEntry: (text: string) => void;
  /** 向当前 streaming entry 追加推理文本 */
  appendReasoningToStreamingEntry: (reasoning: string) => void;
  /** Stage debug info that will be attached to the next finalized entry */
  stagePendingDebug: (info: { promptSnapshot?: PromptSnapshot; finishReason?: string }) => void;
  /** Add a tool call to the pending list (attached on finalize) */
  addPendingToolCall: (entry: Omit<ToolCallEntry, 'timestamp'>) => void;
  /** 标记当前 streaming entry 完成，附加调试信息，清空 pending 状态 */
  finalizeStreamingEntry: () => void;
  setStatus: (status: GameState['status']) => void;
  setError: (error: string | null) => void;
  setInputHint: (hint: string | null) => void;
  setInputType: (type: 'freetext' | 'choice', choices?: string[] | null) => void;
  updateDebug: (debug: Partial<DebugUpdate>) => void;
  addToolCall: (entry: Omit<ToolCallEntry, 'timestamp'>) => void;
  reset: () => void;
}

interface DebugUpdate {
  stateVars: Record<string, unknown>;
  totalTurns: number;
  tokenBreakdown: TokenBreakdownInfo | null;
  memoryEntryCount: number;
  memorySummaryCount: number;
  memoryEntries: Array<{ role: string; content: string; pinned?: boolean }>;
  memorySummaries: string[];
  changelogEntries: Array<{ turn: number; key: string; oldValue: unknown; newValue: unknown; source: string }>;
  assembledSystemPrompt: string | null;
  assembledMessages: Array<{ role: string; content: string }>;
  activeSegmentIds: string[];
}

// ============================================================================
// ID Generator
// ============================================================================

let counter = 0;
function generateId(): string {
  return `entry-${Date.now()}-${++counter}`;
}

// ============================================================================
// Store
// ============================================================================

const initialState = {
  status: 'idle' as const,
  error: null,
  entries: [] as NarrativeEntry[],
  streamingEntryId: null as string | null,
  pendingToolCalls: [] as ToolCallEntry[],
  pendingPromptSnapshot: null as PromptSnapshot | null,
  pendingFinishReason: null as string | null,
  inputHint: null as string | null,
  inputType: 'freetext' as const,
  choices: null as string[] | null,
  stateVars: {} as Record<string, unknown>,
  totalTurns: 0,
  toolCalls: [] as ToolCallEntry[],
  tokenBreakdown: null as TokenBreakdownInfo | null,
  memoryEntryCount: 0,
  memorySummaryCount: 0,
  memoryEntries: [] as Array<{ role: string; content: string; pinned?: boolean }>,
  memorySummaries: [] as string[],
  changelogEntries: [] as Array<{ turn: number; key: string; oldValue: unknown; newValue: unknown; source: string }>,
  assembledSystemPrompt: null as string | null,
  assembledMessages: [] as Array<{ role: string; content: string }>,
  activeSegmentIds: [] as string[],
};

export const useGameStore = create<GameState>((set) => ({
  ...initialState,

  appendEntry: (entry) =>
    set((state) => ({
      entries: [
        ...state.entries,
        { ...entry, id: generateId(), timestamp: Date.now() },
      ],
    })),

  beginStreamingEntry: () => {
    const id = generateId();
    set((state) => ({
      entries: [
        ...state.entries,
        {
          id,
          role: 'generate' as const,
          content: '',
          timestamp: Date.now(),
          streaming: true,
        },
      ],
      streamingEntryId: id,
    }));
    return id;
  },

  appendToStreamingEntry: (text) =>
    set((state) => {
      const sid = state.streamingEntryId;
      if (!sid) return state;
      return {
        entries: state.entries.map((e) =>
          e.id === sid ? { ...e, content: e.content + text } : e,
        ),
      };
    }),

  appendReasoningToStreamingEntry: (reasoning) =>
    set((state) => {
      const sid = state.streamingEntryId;
      if (!sid) return state;
      return {
        entries: state.entries.map((e) =>
          e.id === sid
            ? { ...e, reasoning: (e.reasoning ?? '') + reasoning }
            : e,
        ),
      };
    }),

  stagePendingDebug: (info) =>
    set((state) => ({
      pendingPromptSnapshot: info.promptSnapshot ?? state.pendingPromptSnapshot,
      pendingFinishReason: info.finishReason ?? state.pendingFinishReason,
    })),

  addPendingToolCall: (entry) =>
    set((state) => ({
      pendingToolCalls: [...state.pendingToolCalls, { ...entry, timestamp: Date.now() }],
    })),

  finalizeStreamingEntry: () =>
    set((state) => {
      const sid = state.streamingEntryId;
      if (!sid) {
        // 没有活跃的 streaming entry，只清理 pending
        return {
          pendingToolCalls: [],
          pendingPromptSnapshot: null,
          pendingFinishReason: null,
        };
      }
      return {
        entries: state.entries
          .map((e) =>
            e.id === sid
              ? {
                  ...e,
                  streaming: false,
                  toolCalls: state.pendingToolCalls.length > 0 ? state.pendingToolCalls : e.toolCalls,
                  promptSnapshot: state.pendingPromptSnapshot ?? e.promptSnapshot,
                  finishReason: state.pendingFinishReason ?? e.finishReason,
                }
              : e,
          )
          // 移除空内容的 streaming entry（边界情况：begin 了但没收到任何文本）
          .filter((e) => !(e.id === sid && !e.content && !e.reasoning)),
        streamingEntryId: null,
        pendingToolCalls: [],
        pendingPromptSnapshot: null,
        pendingFinishReason: null,
      };
    }),

  setStatus: (status) => set({ status }),

  setError: (error) => set({ error, status: error ? 'error' : 'idle' }),

  setInputHint: (inputHint) => set({ inputHint }),

  setInputType: (inputType, choices = null) => set({ inputType, choices }),

  updateDebug: (debug) => set(debug),

  addToolCall: (entry) =>
    set((state) => ({
      toolCalls: [...state.toolCalls, { ...entry, timestamp: Date.now() }],
    })),

  reset: () => set(initialState),
}));
