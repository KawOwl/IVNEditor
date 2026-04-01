/**
 * GameStore — Zustand 全局状态管理
 *
 * 连接引擎核心（CoreLoop, LLMClient, etc.）和 UI 层。
 * UI 组件只读取此 store，所有引擎操作通过 actions 触发。
 */

import { create } from 'zustand';

// ============================================================================
// Types
// ============================================================================

export interface NarrativeEntry {
  id: string;
  role: 'generate' | 'receive' | 'system';
  content: string;
  reasoning?: string;          // LLM reasoning/thinking (debug mode)
  toolCalls?: ToolCallEntry[]; // tool calls made during this generation (debug mode)
  promptSnapshot?: PromptSnapshot; // prompt used to generate this entry (debug mode)
  finishReason?: string;       // LLM finish reason (debug mode)
  timestamp: number;
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

export interface GameState {
  // --- Session Status ---
  status: 'idle' | 'loading' | 'generating' | 'waiting-input' | 'compressing' | 'error';
  error: string | null;

  // --- Narrative ---
  entries: NarrativeEntry[];
  streamingText: string;       // current LLM streaming output (partial)
  streamingReasoning: string;  // current LLM reasoning output (partial)
  isStreaming: boolean;

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
  setStreamingText: (text: string) => void;
  appendStreamingChunk: (chunk: string) => void;
  appendReasoningChunk: (chunk: string) => void;
  /** Stage debug info that will be attached to the next finalized entry */
  stagePendingDebug: (info: { promptSnapshot?: PromptSnapshot; finishReason?: string }) => void;
  /** Add a tool call to the pending list (attached on finalize) */
  addPendingToolCall: (entry: Omit<ToolCallEntry, 'timestamp'>) => void;
  finalizeStreaming: () => void;
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
  entries: [],
  streamingText: '',
  streamingReasoning: '',
  isStreaming: false,
  pendingToolCalls: [],
  pendingPromptSnapshot: null,
  pendingFinishReason: null,
  inputHint: null,
  inputType: 'freetext' as const,
  choices: null,
  stateVars: {},
  totalTurns: 0,
  toolCalls: [],
  tokenBreakdown: null,
  memoryEntryCount: 0,
  memorySummaryCount: 0,
  memoryEntries: [],
  memorySummaries: [],
  changelogEntries: [],
  assembledSystemPrompt: null,
  assembledMessages: [],
  activeSegmentIds: [],
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

  setStreamingText: (text) =>
    set({ streamingText: text, isStreaming: true }),

  appendStreamingChunk: (chunk) =>
    set((state) => ({
      streamingText: state.streamingText + chunk,
      isStreaming: true,
    })),

  appendReasoningChunk: (chunk) =>
    set((state) => ({
      streamingReasoning: state.streamingReasoning + chunk,
      isStreaming: true,
    })),

  stagePendingDebug: (info) =>
    set((state) => ({
      pendingPromptSnapshot: info.promptSnapshot ?? state.pendingPromptSnapshot,
      pendingFinishReason: info.finishReason ?? state.pendingFinishReason,
    })),

  addPendingToolCall: (entry) =>
    set((state) => ({
      pendingToolCalls: [...state.pendingToolCalls, { ...entry, timestamp: Date.now() }],
    })),

  finalizeStreaming: () =>
    set((state) => {
      if (!state.streamingText && !state.streamingReasoning) {
        return {
          isStreaming: false,
          pendingToolCalls: [],
          pendingPromptSnapshot: null,
          pendingFinishReason: null,
        };
      }
      return {
        entries: [
          ...state.entries,
          {
            id: generateId(),
            role: 'generate' as const,
            content: state.streamingText,
            reasoning: state.streamingReasoning || undefined,
            toolCalls: state.pendingToolCalls.length > 0 ? state.pendingToolCalls : undefined,
            promptSnapshot: state.pendingPromptSnapshot ?? undefined,
            finishReason: state.pendingFinishReason ?? undefined,
            timestamp: Date.now(),
          },
        ],
        streamingText: '',
        streamingReasoning: '',
        isStreaming: false,
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
