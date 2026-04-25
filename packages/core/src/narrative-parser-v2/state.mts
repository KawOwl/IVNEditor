/**
 * Narrative Parser v2 — State
 *
 * 纯数据层：定义 ParserState 形状 + 初始值 + 最细粒度的纯函数变换。
 * 所有函数都是 `(state, patch) → newState`，不 mutate。
 *
 * 设计原则对齐 RFC §2 原则 #7：parser 层禁顶层可变 let / class；
 * state 通过 reducer 返回新对象演进。
 */

import type {
  ParticipationFrame,
  SceneState,
  Sentence,
  ScratchBlock,
  SpriteState,
} from '#internal/types';
import type { DegradeCode, TopLevelKind } from '#internal/narrative-parser-v2/tag-schema';

// ============================================================================
// Manifest（parser 需要的白名单子集）
// ============================================================================

/**
 * parser 只需要白名单信息；为了解耦，我们不直接吃 ScriptManifest，
 * 而是让调用方（GameSession）预计算这张小表。
 */
export interface ParserManifest {
  /** 合法的 character id（也是 sprite `char` 和 dialogue `speaker` 的白名单） */
  readonly characters: ReadonlySet<string>;
  /** char id → 合法 mood id set */
  readonly moodsByChar: ReadonlyMap<string, ReadonlySet<string>>;
  /** 合法的 background scene id */
  readonly backgrounds: ReadonlySet<string>;
}

// ============================================================================
// Pending Unit（正在组装的顶层容器，关闭时 resolve 成 Sentence/ScratchBlock）
// ============================================================================

export interface PendingUnit {
  readonly kind: TopLevelKind;
  readonly textBuffer: string;
  /** 对话属性（kind='dialogue' 时填） */
  readonly pf?: ParticipationFrame;
  /** dialogue 原始 speaker 属性（可能不在白名单，保留原文） */
  readonly rawSpeaker?: string;
  /** speaker 属性缺失（会在 close 时 degrade 为 narration） */
  readonly speakerMissing?: boolean;
  /** 子标签累积 */
  readonly pendingBg?: { scene: string };
  readonly pendingSprites: ReadonlyArray<SpriteState>;
  readonly pendingClearStage: boolean;
}

export function emptyPendingUnit(
  kind: TopLevelKind,
  init?: Partial<PendingUnit>,
): PendingUnit {
  return {
    kind,
    textBuffer: '',
    pendingSprites: [],
    pendingClearStage: false,
    ...init,
  };
}

// ============================================================================
// ParserState — 跨 chunk 的不可变快照
// ============================================================================

export interface ParserState {
  /** 全局索引，Sentence / ScratchBlock 递增共享 */
  readonly nextIndex: number;
  /** 当前 turn 编号（外部注入，parser 只读） */
  readonly turnNumber: number;
  /** 上一条产出的 Sentence 的 sceneRef（给新单元计算继承） */
  readonly lastScene: SceneState;
  /** 顶层容器栈。顶层标签嵌套时最近的在最后。 */
  readonly containerStack: ReadonlyArray<PendingUnit>;
  /** 未知顶层标签的深度（用于丢弃未知标签内的所有内容） */
  readonly unknownDepth: number;
  /**
   * 容器外裸文本累积缓冲区。
   *
   * SAX 对中文等 CJK 文本会逐 chunk 发 text 事件（`我先` / `查` / `一下` ...）。
   * 如果 LLM 在第一个顶层容器之前写了 meta-reasoning，每个 chunk 各自 emit 一条
   * degrade + 一条 narration 会把 UI / Langfuse 搞得很乱。
   *
   * 策略：逐 chunk append 到本 buffer，**不产 Sentence**。在下一次 opentag 或
   * finalize 时合并成**一条** `bare-text-outside-container` degrade（detail 带
   * 累计文本前若干字符），然后丢弃。符合 RFC §4.3 silent tolerance 语义
   * （原文本存在 degrade detail 里便于调试，但不会渲染给玩家）。
   */
  readonly bareTextBuffer: string;
  /** 是否已 finalize（之后拒绝新输入） */
  readonly finalized: boolean;
}

export function initialParserState(init: {
  turnNumber: number;
  startIndex: number;
  initialScene: SceneState;
}): ParserState {
  return {
    nextIndex: init.startIndex,
    turnNumber: init.turnNumber,
    lastScene: init.initialScene,
    containerStack: [],
    unknownDepth: 0,
    bareTextBuffer: '',
    finalized: false,
  };
}

// ============================================================================
// Reducer 输出——每一步可能带出的产物
// ============================================================================

export interface ReducerOutputs {
  readonly sentences: ReadonlyArray<Sentence>;
  readonly scratches: ReadonlyArray<ScratchBlock>;
  readonly degrades: ReadonlyArray<DegradeEvent>;
}

export interface DegradeEvent {
  readonly code: DegradeCode;
  readonly detail?: string;
}

export const EMPTY_OUTPUTS: ReducerOutputs = {
  sentences: [],
  scratches: [],
  degrades: [],
};

export function concatOutputs(a: ReducerOutputs, b: ReducerOutputs): ReducerOutputs {
  if (
    a.sentences.length === 0 &&
    a.scratches.length === 0 &&
    a.degrades.length === 0
  )
    return b;
  if (
    b.sentences.length === 0 &&
    b.scratches.length === 0 &&
    b.degrades.length === 0
  )
    return a;
  return {
    sentences: [...a.sentences, ...b.sentences],
    scratches: [...a.scratches, ...b.scratches],
    degrades: [...a.degrades, ...b.degrades],
  };
}

export interface ReducerResult {
  readonly state: ParserState;
  readonly outputs: ReducerOutputs;
}

export const identityResult = (state: ParserState): ReducerResult => ({
  state,
  outputs: EMPTY_OUTPUTS,
});

// ============================================================================
// 栈操作辅助（纯函数，返回新数组）
// ============================================================================

export function pushContainer(
  stack: ReadonlyArray<PendingUnit>,
  unit: PendingUnit,
): ReadonlyArray<PendingUnit> {
  return [...stack, unit];
}

export function popContainer(
  stack: ReadonlyArray<PendingUnit>,
): { rest: ReadonlyArray<PendingUnit>; top: PendingUnit | null } {
  if (stack.length === 0) return { rest: stack, top: null };
  const top = stack[stack.length - 1];
  if (!top) return { rest: stack, top: null };
  return { rest: stack.slice(0, -1), top };
}

export function replaceTop(
  stack: ReadonlyArray<PendingUnit>,
  updater: (top: PendingUnit) => PendingUnit,
): ReadonlyArray<PendingUnit> {
  if (stack.length === 0) return stack;
  const top = stack[stack.length - 1];
  if (!top) return stack;
  const rest = stack.slice(0, -1);
  return [...rest, updater(top)];
}

export function peekContainer(
  stack: ReadonlyArray<PendingUnit>,
): PendingUnit | null {
  if (stack.length === 0) return null;
  return stack[stack.length - 1] ?? null;
}
