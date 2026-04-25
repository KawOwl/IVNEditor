/**
 * Narrative Parser v2 — 声明式 Tag Schema
 *
 * RFC-声明式视觉IR_2026-04-24.md §3.1 的 TypeScript 编码。
 * 本文件是**纯数据**：没有逻辑、没有 IO、不依赖 htmlparser2。
 * 其他模块（reducer / inheritance / index）读这张表决定行为，
 * 加新标签 = 往表里加一行。
 *
 * §2 原则 #7（函数式 / 组合式 / 声明式）的具体体现：
 * 把"哪些标签合法、属性如何、子标签规则"从控制流里抽出成可查询的结构。
 */

// ============================================================================
// 顶层容器（产出 Sentence 或 ScratchBlock）
// ============================================================================

/** 顶层容器分类。决定关闭时产出什么。 */
export type TopLevelKind = 'dialogue' | 'narration' | 'scratch';

export interface TopLevelTagSpec {
  /** 在源文本里出现的 tag 名（htmlparser2 lowercase） */
  readonly name: 'dialogue' | 'narration' | 'scratch';
  /** 该容器关闭时产出什么 */
  readonly kind: TopLevelKind;
  /** 合法的属性名白名单；未在此表的属性忽略（silent tolerance） */
  readonly allowedAttrs: ReadonlyArray<DialogueAttrKey | never>;
  /** 是否产出 Sentence（否 = 只做 ScratchBlock / 丢弃） */
  readonly producesSentence: boolean;
  /** 是否允许视觉子标签（background / sprite / stage） */
  readonly allowsVisualChildren: boolean;
}

/** `<dialogue>` 的合法属性 key */
export type DialogueAttrKey = 'speaker' | 'to' | 'hear' | 'eavesdroppers';

export const TOP_LEVEL_TAGS: ReadonlyArray<TopLevelTagSpec> = [
  {
    name: 'dialogue',
    kind: 'dialogue',
    allowedAttrs: ['speaker', 'to', 'hear', 'eavesdroppers'],
    producesSentence: true,
    allowsVisualChildren: true,
  },
  {
    name: 'narration',
    kind: 'narration',
    allowedAttrs: [],
    producesSentence: true,
    allowsVisualChildren: true,
  },
  {
    name: 'scratch',
    kind: 'scratch',
    allowedAttrs: [],
    producesSentence: false,  // 不产出 Sentence，产 ScratchBlock
    allowsVisualChildren: false,
  },
];

/** 快查表：name → spec（一次构建，parser 运行时 O(1) 查）。 */
export const TOP_LEVEL_BY_NAME: Readonly<Record<string, TopLevelTagSpec>> =
  Object.freeze(
    TOP_LEVEL_TAGS.reduce<Record<string, TopLevelTagSpec>>((acc, spec) => {
      acc[spec.name] = spec;
      return acc;
    }, {}),
  );

// ============================================================================
// 视觉子标签（自闭合，写在顶层容器内）
// ============================================================================

/** 视觉子标签分类 */
export type VisualChildKind = 'background' | 'sprite' | 'stage';

export interface VisualChildTagSpec {
  readonly name: VisualChildKind;
  /** 必填属性（缺任意一个 → 整个 tag drop，记 degrade） */
  readonly requiredAttrs: ReadonlyArray<string>;
  /** 可选属性（未来扩展，目前空） */
  readonly optionalAttrs: ReadonlyArray<string>;
  /** 和哪些同级 tag 互斥（stage vs sprite） */
  readonly mutuallyExclusiveWith: ReadonlyArray<VisualChildKind>;
}

export const VISUAL_CHILD_TAGS: ReadonlyArray<VisualChildTagSpec> = [
  {
    name: 'background',
    requiredAttrs: ['scene'],
    optionalAttrs: [],
    mutuallyExclusiveWith: [],
  },
  {
    name: 'sprite',
    requiredAttrs: ['char', 'mood', 'position'],
    optionalAttrs: [],
    mutuallyExclusiveWith: ['stage'],
  },
  {
    name: 'stage',
    requiredAttrs: [],
    optionalAttrs: [],
    mutuallyExclusiveWith: ['sprite'],
  },
];

export const VISUAL_CHILD_BY_NAME: Readonly<Record<string, VisualChildTagSpec>> =
  Object.freeze(
    VISUAL_CHILD_TAGS.reduce<Record<string, VisualChildTagSpec>>((acc, spec) => {
      acc[spec.name] = spec;
      return acc;
    }, {}),
  );

// ============================================================================
// 分类查询辅助（纯函数，不依赖 state）
// ============================================================================

export function isTopLevelTag(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOP_LEVEL_BY_NAME, name);
}

export function isVisualChildTag(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(VISUAL_CHILD_BY_NAME, name);
}

/** 合法位置值 */
export const VALID_POSITIONS: ReadonlyArray<'left' | 'center' | 'right'> = [
  'left',
  'center',
  'right',
];

export function isValidPosition(v: string): v is 'left' | 'center' | 'right' {
  return (VALID_POSITIONS as ReadonlyArray<string>).includes(v);
}

// ============================================================================
// Degrade 事件名（分类一份）。和 Langfuse tag 对齐（RFC §10.1）。
// ============================================================================

/**
 * 所有 silent-degrade 的分类名。reducer 只输出这个 union，
 * 调用方（tracing）决定打成 `ir-degrade:*` 还是其他形式。
 */
export type DegradeCode =
  | 'sprite-missing-attr'
  | 'sprite-unknown-char'
  | 'sprite-unknown-mood'
  | 'sprite-invalid-position'
  | 'stage-and-sprite-conflict'
  | 'bg-missing-attr'
  | 'bg-unknown-scene'
  | 'unknown-toplevel-tag'
  | 'container-truncated'
  | 'dialogue-missing-speaker'
  | 'dialogue-unknown-speaker'
  | 'bare-text-outside-container';
