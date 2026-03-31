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
  timestamp: number;
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
  isStreaming: boolean;

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

  // --- Actions ---
  appendEntry: (entry: Omit<NarrativeEntry, 'id' | 'timestamp'>) => void;
  setStreamingText: (text: string) => void;
  appendStreamingChunk: (chunk: string) => void;
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
  isStreaming: false,
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

  finalizeStreaming: () =>
    set((state) => {
      if (!state.streamingText) return { isStreaming: false };
      return {
        entries: [
          ...state.entries,
          {
            id: generateId(),
            role: 'generate' as const,
            content: state.streamingText,
            timestamp: Date.now(),
          },
        ],
        streamingText: '',
        isStreaming: false,
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
