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
   * 推进规则：
   *   - 玩家点 stage / 按 Space-Enter-→ 时 +1（封顶 length-1）
   *   - 当 catchUpPending=true 且玩家在末端 + 新 Sentence 到达 → 自动 +1
   *     （详见 catchUpPending 字段注释）
   */
  visibleSentenceIndex: number | null;

  /**
   * 是否有一个"追赶"（catch-up）动作待执行。
   *
   * 语义：玩家做完一次主动动作后处于"等内容"状态；这时 LLM 吐出的第一条新
   * Sentence 会把玩家推到它上面（免得玩家盯着空白等）。**只执行一次**，
   * 之后的新 Sentence 都等玩家手动点。
   *
   * 状态转移：
   *   true  → 任何主动动作：appendSentence 第一次初始化游标 / advanceSentence /
   *                        setVisibleSentenceIndex / seedOpeningSentences / reset
   *   false → appendSentence 成功触发一次 catch-up 后
   *
   * 像一个 one-shot 的 pending job：
   *   - 有任务排队（pending=true）→ 条件满足 → 处理掉（pending=false）
   *   - 没处理掉就一直排着，等条件满足的那一次 appendSentence
   */
  catchUpPending: boolean;

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
  // 初始 true：剧本刚开始时第一条 Sentence 到达就能自动显示给玩家
  catchUpPending: true,
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
      const prev = state.parsedSentences;
      const next = [...prev, sentence];
      let vsi = state.visibleSentenceIndex;
      let pending = state.catchUpPending;

      // "跳过型" Sentence —— 不占对话框 click 次数：
      //   scene_change  视觉切换帧
      //   signal_input  选项事件（live 下由 choices 面板承担交互，backlog 下仅回看）
      const isSkippable = (s: Sentence) => s.kind === 'scene_change' || s.kind === 'signal_input';

      // 游标初始化：首次追加时从 null → 找第一个非跳过型的位置。
      if (vsi === null) {
        const firstReadable = next.findIndex((s) => !isSkippable(s));
        vsi = firstReadable >= 0 ? firstReadable : null;
        // 初始化已经把玩家推到第一条；catch-up 任务这次就算完成了
        return { parsedSentences: next, visibleSentenceIndex: vsi, catchUpPending: false };
      }

      // catch-up：玩家刚做过主动动作（catchUpPending=true）+ 在末端 + 新 Sentence
      // 不是跳过型 → 自动把游标推到新末尾，然后把 pending 置 false。
      // 后续新 Sentence 不再连续自动前进，直到玩家再做主动动作（advance /
      // setVisibleSentenceIndex）重新置 pending=true。
      let lastReadableInPrev = prev.length - 1;
      while (lastReadableInPrev >= 0 && isSkippable(prev[lastReadableInPrev]!)) {
        lastReadableInPrev--;
      }
      const playerAtTail = vsi === lastReadableInPrev;
      const canCatchUp =
        pending &&
        playerAtTail &&
        !isSkippable(sentence);

      if (canCatchUp) {
        vsi = next.length - 1;
        pending = false;
      }
      // 其它情况（pending=false / 玩家在往回翻 / 新 Sentence 是 scene_change / signal_input）
      // 都不动游标。

      return { parsedSentences: next, visibleSentenceIndex: vsi, catchUpPending: pending };
    }),

  setCurrentScene: (scene, transition) =>
    set(transition ? { currentScene: scene, lastSceneTransition: transition } : { currentScene: scene }),

  // --- M1: Playback cursor ---
  advanceSentence: () =>
    set((state) => {
      if (state.parsedSentences.length === 0) return state;
      // scene_change + signal_input 都属"跳过型" Sentence（不占 click）
      const isSkippable = (s: Sentence) => s.kind === 'scene_change' || s.kind === 'signal_input';
      let next = (state.visibleSentenceIndex ?? -1) + 1;
      // 连续跳过跳过型 Sentence（VN 的"场景切换帧 / signal_input 事件"不占 click 次数）
      while (next < state.parsedSentences.length && isSkippable(state.parsedSentences[next]!)) {
        next += 1;
      }
      // 越界 → 找最后一个非跳过型的 index 停住，
      // 不要推到 length，避免 DialogBox 显示空白 "…" 让玩家以为还有后文。
      if (next >= state.parsedSentences.length) {
        let last = state.parsedSentences.length - 1;
        while (last >= 0 && isSkippable(state.parsedSentences[last]!)) last--;
        if (last < 0) return state; // 整串都跳过型，什么也别动
        return { visibleSentenceIndex: last, catchUpPending: true };
      }
      // 玩家主动推进 → re-arm catch-up，下次新 Sentence 来时允许再自动推一次
      return { visibleSentenceIndex: next, catchUpPending: true };
    }),

  setVisibleSentenceIndex: (n) => set({ visibleSentenceIndex: n, catchUpPending: true }),

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
        // seed 刚刚把玩家推到第 0 条，下次新 Sentence 来时允许 catch-up 到新内容
        catchUpPending: true,
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
    catchUpPending: true,
    lastSceneTransition: 'fade',
  }),
}));

// Dev-only：暴露 store 到 window，方便在浏览器 console 里 inspect：
//   __gs.getState().parsedSentences / __gs.getState().visibleSentenceIndex
if (typeof window !== 'undefined') {
  (window as unknown as { __gs: typeof useGameStore }).__gs = useGameStore;
}
