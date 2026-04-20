/**
 * GameStore — Zustand 全局状态管理
 *
 * 连接引擎核心（CoreLoop, LLMClient, etc.）和 UI 层。
 * UI 组件只读取此 store，所有引擎操作通过 actions 触发。
 */

import { create } from 'zustand';

// Session types 定义在 core/types.ts，此处 re-export 供 UI 层使用
export type {
  PromptSnapshot,
  ToolCallEntry,
  TokenBreakdownInfo,
  Sentence,
  SceneState,
} from '../core/types';

import type {
  ToolCallEntry,
  TokenBreakdownInfo,
  Sentence,
  SceneState,
} from '../core/types';

// ============================================================================
// Types
// ============================================================================

export interface GameState {
  // --- Session Status ---
  status: 'idle' | 'loading' | 'generating' | 'waiting-input' | 'compressing' | 'error' | 'finished';
  error: string | null;

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

  // --- VN Narrative & Scene (M3) ---
  /** Parser 产出的结构化 Sentence 序列（M1 VN UI 消费）。按产生顺序追加，不删除。 */
  parsedSentences: Sentence[];
  /** 当前 VN 场景快照（change_scene/change_sprite/clear_stage 工具演进）。 */
  currentScene: SceneState;
  /** M1 Step 1.5：最近一次 scene-change 的过渡类型；SceneBackground 组件据此选动效 */
  lastSceneTransition: 'fade' | 'cut' | 'dissolve';

  // --- VN Playback Cursor (M1) ---
  /**
   * 玩家当前看到的 Sentence 在 parsedSentences 中的索引。
   * null = 还没开始 / 刚重置；0..N-1 = 正常；=== length-1 且后端没新 Sentence 时显示"等待..."
   *
   * 推进规则（M1 只做 manual）：
   *   - 玩家点 stage / 按 Space-Enter-→ 时 +1（封顶 length-1）
   *   - 新 Sentence 到达时游标**不自动前进**（除非游标从未被初始化则初始化为 0）
   */
  visibleSentenceIndex: number | null;

  // --- Actions ---
  setStatus: (status: GameState['status']) => void;
  setError: (error: string | null) => void;
  setInputHint: (hint: string | null) => void;
  setInputType: (type: 'freetext' | 'choice', choices?: string[] | null) => void;
  updateDebug: (debug: Partial<DebugUpdate>) => void;
  addToolCall: (entry: Omit<ToolCallEntry, 'timestamp'>) => void;
  /** M3: 追加解析出的 Sentence（narration / dialogue / scene_change） */
  appendSentence: (sentence: Sentence) => void;
  /** M3: 更新当前场景快照；M1: 可选传入 transition，用于下一帧 SceneBackground 选动效 */
  setCurrentScene: (scene: SceneState, transition?: 'fade' | 'cut' | 'dissolve') => void;
  /** M1: 游标 +1；自动跳过 scene_change（它们只驱动视觉切换，不占 click 次数） */
  advanceSentence: () => void;
  /** M1: 游标直接设值（用于 backlog / 恢复） */
  setVisibleSentenceIndex: (n: number | null) => void;
  /**
   * M1 Step 1.3：用剧本的 openingMessages 预置 N 条 synthetic narration Sentence。
   *
   * 行为：
   *   - 每条 message 合成 `{kind:'narration', sceneRef: scene, index: -(N)..-1}`
   *     塞到 parsedSentences 前面
   *   - 同时把 visibleSentenceIndex 置为 0（第一条开场）
   *   - 同时把 currentScene 初始化为 defaultScene（如果还是空初始值）
   *
   * 只应该在玩家首次开始（非重连）时调用；重连时服务端会重放真实 Sentences，
   * 不能再盖一层开场气泡。
   */
  seedOpeningSentences: (messages: string[], scene: SceneState) => void;
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
// Store
// ============================================================================

const initialState = {
  status: 'idle' as const,
  error: null,
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
  parsedSentences: [] as Sentence[],
  currentScene: { background: null, sprites: [] } as SceneState,
  visibleSentenceIndex: null as number | null,
  lastSceneTransition: 'fade' as 'fade' | 'cut' | 'dissolve',
};

export const useGameStore = create<GameState>((set) => ({
  ...initialState,

  setStatus: (status) => set({ status }),

  setError: (error) => set({ error, status: error ? 'error' : 'idle' }),

  setInputHint: (inputHint) => set({ inputHint }),

  setInputType: (inputType, choices = null) => set({ inputType, choices }),

  updateDebug: (debug) => set(debug),

  addToolCall: (entry) =>
    set((state) => ({
      toolCalls: [...state.toolCalls, { ...entry, timestamp: Date.now() }],
    })),

  // --- M3: VN Narrative & Scene ---
  appendSentence: (sentence) =>
    set((state) => {
      const next = [...state.parsedSentences, sentence];
      // 游标初始化：首次追加时从 null → 找第一个非 scene_change 的位置。
      // scene_change 只驱动背景/立绘切换，不应该让玩家看到空白对话框。
      let vsi = state.visibleSentenceIndex;
      if (vsi === null) {
        const firstNonSC = next.findIndex((s) => s.kind !== 'scene_change');
        vsi = firstNonSC >= 0 ? firstNonSC : null;
      }
      return { parsedSentences: next, visibleSentenceIndex: vsi };
    }),

  setCurrentScene: (scene, transition) =>
    set(transition ? { currentScene: scene, lastSceneTransition: transition } : { currentScene: scene }),

  // --- M1: Playback cursor ---
  advanceSentence: () =>
    set((state) => {
      if (state.parsedSentences.length === 0) return state;
      let next = (state.visibleSentenceIndex ?? -1) + 1;
      // 连续跳过 scene_change（VN 的"场景切换帧"不占 click 次数）
      while (next < state.parsedSentences.length && state.parsedSentences[next]?.kind === 'scene_change') {
        next += 1;
      }
      // next 可能 === parsedSentences.length，越界时 VNStageContainer 的
      // sentence 取值为 undefined → DialogBox 显示 "…" 等待后续 Sentence。
      return { visibleSentenceIndex: next };
    }),

  setVisibleSentenceIndex: (n) => set({ visibleSentenceIndex: n }),

  seedOpeningSentences: (messages, scene) =>
    set((state) => {
      if (messages.length === 0) return state;
      const N = messages.length;
      const openers: Sentence[] = messages.map((text, i) => ({
        kind: 'narration' as const,
        text,
        sceneRef: scene,
        turnNumber: 0,
        // 用负数 index 和真实 LLM 产出的 Sentence 区分（真实从 0 起）
        index: -(N) + i,
      }));
      return {
        parsedSentences: [...openers, ...state.parsedSentences],
        // 玩家进来看到的第一句就是第一条 opening
        visibleSentenceIndex: 0,
        // 如果 currentScene 还是 fresh 初值，用 defaultScene 预置，避免黑幕
        currentScene:
          state.currentScene.background === null && state.currentScene.sprites.length === 0
            ? scene
            : state.currentScene,
      };
    }),

  reset: () => set({
    ...initialState,
    parsedSentences: [],
    currentScene: { background: null, sprites: [] },
    visibleSentenceIndex: null,
    lastSceneTransition: 'fade',
  }),
}));

// Dev-only：暴露 store 到 window，方便在浏览器 console 里 inspect：
//   __gs.getState().parsedSentences / __gs.getState().visibleSentenceIndex
if (typeof window !== 'undefined') {
  (window as unknown as { __gs: typeof useGameStore }).__gs = useGameStore;
}
