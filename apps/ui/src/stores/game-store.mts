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
} from '@ivn/core/types';

import type {
  ToolCallEntry,
  TokenBreakdownInfo,
  Sentence,
  SceneState,
} from '@ivn/core/types';

// ============================================================================
// Types
// ============================================================================

// ============================================================================
// ANN.1 Memory annotation types
// ============================================================================

export type MemoryReasonCode = 'character-broken' | 'memory-confused' | 'logic-error' | 'other';

export interface MemoryRetrievalEntry {
  id: string;
  turn: number;
  role: string;
  content: string;
  tokenCount: number;
  timestamp: number;
  pinned?: boolean;
}

export interface MemoryRetrievalView {
  retrievalId: string;
  turn: number;
  source: 'context-assembly' | 'tool-call';
  query: string;
  entries: MemoryRetrievalEntry[];
  summary: string;
}

export interface MemoryDeletionView {
  annotationId: string;
  memoryEntryId: string;
  reasonCode: MemoryReasonCode;
  /** 5s 撤销窗内是否仍可撤销 */
  cancellable: boolean;
  /** ms epoch */
  createdAt: number;
}

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

  // --- Narrative Rewrite (PR2) ---
  /**
   * 当前是否在 narrative-rewrite 阶段（主 LLM 完成后的语义归一化层）。
   * UI 据此显示 loading 全覆盖（PR2 最简版）/ 半透明遮罩（PR3）。
   */
  isRewriting: boolean;

  // --- ANN.1 Memory annotation ---
  /**
   * 最近 N 个 turn 的 retrieval（带 entries），最新在末尾。
   * MemoryPanel 默认显示最后一个的 entries 集合（去重 by entry.id）。
   */
  memoryRetrievals: MemoryRetrievalView[];
  /**
   * by entryId 索引的删除标注。包括 active + 5s 撤销窗内的新标注。
   * 5s 后 cancellable 翻 false（仍保留在 map 里给 UI 用 reasonCode 渲染灰态）。
   */
  memoryDeletions: Record<string, MemoryDeletionView>;
  // --- Assembled Context (for editor debug) ---
  assembledSystemPrompt: string | null;
  assembledMessages: Array<{ role: string; content: string }>;
  activeSegmentIds: string[];

  // --- VN Narrative & Scene (M3) ---
  /** Parser 产出的结构化 Sentence 序列（M1 VN UI 消费）。按产生顺序追加，不删除。 */
  parsedSentences: Sentence[];
  /** 当前 VN 场景快照（当前协议从 Sentence.sceneRef 派生）。 */
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

  // --- Narrative Rewrite actions ---
  /** rewrite-attempted/-completed → 切换 isRewriting */
  setRewriting: (rewriting: boolean) => void;
  /**
   * narrative-turn-reset → 清掉指定 turn 的 sentence + 重置游标。
   * 用于 rewrite ok 时撤销 raw 的 stream 渲染，让接下来的 narrative-batch
   * emit 重新填充。
   */
  resetTurnSentences: (turnNumber: number) => void;

  // --- ANN.1 Memory annotation actions ---
  /** 接收一次 retrieve 的结果（来自 WS 'memory-retrieval' 事件）*/
  appendMemoryRetrieval: (retrieval: MemoryRetrievalView) => void;
  /** 接收已存在标注集合（list_turn_retrievals 返回的 activeDeletions）*/
  setMemoryDeletions: (deletions: Array<{ annotationId: string; memoryEntryId: string; reasonCode: MemoryReasonCode }>) => void;
  /** 乐观写入：op 调用前本地立即标记，op 失败时再 revert */
  markMemoryDeletedLocal: (input: {
    annotationId: string;
    memoryEntryId: string;
    reasonCode: MemoryReasonCode;
  }) => void;
  /** 撤销窗倒计时结束：把 cancellable 翻 false（保留 reasonCode 用于灰态渲染）*/
  expireMemoryDeletionCancellable: (annotationId: string) => void;
  /** 撤销标注：从 deletions 中移除 */
  removeMemoryDeletion: (annotationId: string) => void;

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
  // PR2 narrative-rewrite
  isRewriting: false,
  // ANN.1
  memoryRetrievals: [] as MemoryRetrievalView[],
  memoryDeletions: {} as Record<string, MemoryDeletionView>,
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
  //
  // 2026-04-23：catchUpPending 自动推进机制暂时关闭。
  //   玩家反馈：LLM 吐新 Sentence 时自动推进游标，会跳过正在打字机显示的那条。
  //   决定：关掉自动追赶，新 Sentence 到达后 hasMore 指示（▼）会闪，玩家手动点击推进。
  //   保留字段 + 所有 re-arm 逻辑不变，以便未来开回来。
  //   见 .claude/plans/vn-catch-up.md
  //
  // 2026-04-24（RFC §11 V.4）：从 Sentence 派生 currentScene。
  //   v2 声明式 IR 下，视觉状态随 Sentence.sceneRef 走，不再 emit mid-session scene-change WS。
  //   所以 appendSentence 需要承担"更新 store.currentScene"的责任，让 catch-up / restore
  //   路径下 store 的场景状态始终跟最新 Sentence 对齐。
  //   v1 path 下 scene-change WS 仍然会独立 setCurrentScene 一次，此处再设同一个值 → 幂等，
  //   所以 v1 行为不变。
  appendSentence: (sentence) =>
    set((state) => {
      const prev = state.parsedSentences;
      const next = [...prev, sentence];
      let vsi = state.visibleSentenceIndex;

      // "跳过型" Sentence —— 不占对话框 click 次数：
      //   scene_change  视觉切换帧
      //   signal_input  选项事件（live 下由 choices 面板承担交互，backlog 下仅回看）
      const isSkippable = (s: Sentence) => s.kind === 'scene_change' || s.kind === 'signal_input';

      // V.4：从 Sentence 派生 currentScene / lastSceneTransition
      //   - scene_change（v1 独有）：用 sentence.scene + sentence.transition
      //   - narration / dialogue / signal_input / player_input：sentence.sceneRef 就是当前场景
      //   - 其它分支（理论上不存在）：保留旧值
      let nextScene = state.currentScene;
      let nextTransition = state.lastSceneTransition;
      if (sentence.kind === 'scene_change') {
        nextScene = sentence.scene;
        if (sentence.transition) nextTransition = sentence.transition;
      } else if (
        sentence.kind === 'narration' ||
        sentence.kind === 'dialogue' ||
        sentence.kind === 'signal_input' ||
        sentence.kind === 'player_input'
      ) {
        nextScene = sentence.sceneRef;
      }

      // 游标初始化：首次追加时从 null → 找第一个非跳过型的位置。
      // 这是不可避免的"第一次自动前进"—— 否则玩家永远看不到开头。
      if (vsi === null) {
        const firstReadable = next.findIndex((s) => !isSkippable(s));
        vsi = firstReadable >= 0 ? firstReadable : null;
        return {
          parsedSentences: next,
          visibleSentenceIndex: vsi,
          catchUpPending: false,
          currentScene: nextScene,
          lastSceneTransition: nextTransition,
        };
      }

      // 关掉 catch-up：无论 pending 状态、玩家是否在末端，新 Sentence 到达不自动推进。
      // 仅追加 Sentence，游标不动。玩家通过点击 / 空格 / DialogBox 的 ▼ 提示手动推进。
      return {
        parsedSentences: next,
        visibleSentenceIndex: vsi,
        catchUpPending: state.catchUpPending,
        currentScene: nextScene,
        lastSceneTransition: nextTransition,
      };
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

  // --- Narrative Rewrite (PR2) ---
  setRewriting: (rewriting) => set({ isRewriting: rewriting }),

  resetTurnSentences: (turnNumber) =>
    set((state) => {
      // 仅保留不属于该 turn 的 sentence；rewrite replay 会通过新一波
      // narrative-batch-emitted 重新填充该 turn 的内容。
      const filtered = state.parsedSentences.filter((s) => {
        // sentence kinds 大多有 turnNumber 字段（narration / dialogue / scratch
        // 等），signal_input / scene_change 也有；player_input 也有。
        const tn = (s as { turnNumber?: number }).turnNumber;
        return tn !== turnNumber;
      });
      // 游标回退：如果游标超出新数组范围，clamp 到末尾
      const vsi =
        state.visibleSentenceIndex !== null && state.visibleSentenceIndex >= filtered.length
          ? Math.max(0, filtered.length - 1)
          : state.visibleSentenceIndex;
      return {
        parsedSentences: filtered,
        visibleSentenceIndex: vsi,
        // catch-up 重新打开，让 replay 后第一条新 Sentence 自动推进游标
        catchUpPending: true,
      };
    }),

  // --- ANN.1 Memory annotation ---
  appendMemoryRetrieval: (retrieval) =>
    set((state) => {
      // 去重 by retrievalId（重连时 server 可能重发）
      if (state.memoryRetrievals.some((r) => r.retrievalId === retrieval.retrievalId)) {
        return state;
      }
      // 保留最近 20 条 retrieval（轮次推进时旧的就老化）
      const next = [...state.memoryRetrievals, retrieval].slice(-20);
      return { memoryRetrievals: next };
    }),

  setMemoryDeletions: (deletions) =>
    set((state) => {
      // 合并：保留本地仍 cancellable=true 的乐观标注（用户刚标的，5s 撤销窗内
      // 还可以撤），不被 server fetch 的"已超过撤销窗的历史标注"覆盖。
      const map: Record<string, MemoryDeletionView> = {};
      for (const d of deletions) {
        map[d.memoryEntryId] = {
          annotationId: d.annotationId,
          memoryEntryId: d.memoryEntryId,
          reasonCode: d.reasonCode,
          cancellable: false,
          createdAt: 0,
        };
      }
      // 把本地仍 cancellable 的（且 server 端可能还没 sync 到）保留
      for (const [k, v] of Object.entries(state.memoryDeletions)) {
        if (v.cancellable) map[k] = v;
      }
      return { memoryDeletions: map };
    }),

  markMemoryDeletedLocal: (input) =>
    set((state) => ({
      memoryDeletions: {
        ...state.memoryDeletions,
        [input.memoryEntryId]: {
          annotationId: input.annotationId,
          memoryEntryId: input.memoryEntryId,
          reasonCode: input.reasonCode,
          cancellable: true,
          createdAt: Date.now(),
        },
      },
    })),

  expireMemoryDeletionCancellable: (annotationId) =>
    set((state) => {
      const next = { ...state.memoryDeletions };
      for (const [k, v] of Object.entries(next)) {
        if (v.annotationId === annotationId && v.cancellable) {
          next[k] = { ...v, cancellable: false };
        }
      }
      return { memoryDeletions: next };
    }),

  removeMemoryDeletion: (annotationId) =>
    set((state) => {
      const next = { ...state.memoryDeletions };
      for (const [k, v] of Object.entries(next)) {
        if (v.annotationId === annotationId) {
          delete next[k];
        }
      }
      return { memoryDeletions: next };
    }),

  reset: () => set({
    ...initialState,
    parsedSentences: [],
    currentScene: { background: null, sprites: [] },
    visibleSentenceIndex: null,
    catchUpPending: true,
    lastSceneTransition: 'fade',
    memoryRetrievals: [],
    memoryDeletions: {},
  }),
}));

// Dev-only：暴露 store 到 window，方便在浏览器 console 里 inspect：
//   __gs.getState().parsedSentences / __gs.getState().visibleSentenceIndex
if (typeof window !== 'undefined') {
  (window as unknown as { __gs: typeof useGameStore }).__gs = useGameStore;
}
