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
// Ad-hoc 角色（白名单外 NPC）约定
// ============================================================================

/**
 * 临时 NPC 角色 id 前缀。剧本作者不可能预设所有路人 / 临时登场角色的 id，
 * 但又希望保持 `<dialogue>` 数据结构（speaker label、participation frame、
 * backlog 头像位等）。约定 `__npc__<显示名>` 作为 ad-hoc speaker id：
 *
 *   <dialogue speaker="__npc__保安" to="player">
 *     "你不能在这里拍照。"
 *   </dialogue>
 *
 * - 后缀部分（即 `id.slice(NPC_SPEAKER_PREFIX.length)`）就是要展示给玩家的名字
 * - 双下划线规避剧本作者真实 snake_case id 撞名（manifest id 命名校验已限制 `^[a-z]`）
 * - 同 trace 内同名 ad-hoc 当作同人，不同 trace / 不同名漂移可接受
 *   （路人本身就是一次性；反复出场要升级到正式 manifest characters）
 * - sprite 仍严格白名单——ad-hoc 角色就是名字气泡，没立绘
 */
export const NPC_SPEAKER_PREFIX = '__npc__';

/**
 * Reserved character id for ad-hoc NPC 立绘占位。字面量恰等于
 * `NPC_SPEAKER_PREFIX`（裸前缀本身），但语义不同：
 *   - `NPC_SPEAKER_PREFIX` 是 dialogue speaker 协议字段的前缀
 *   - `NPC_RESERVED_CHARACTER_ID` 是 manifest.characters 里的一个 reserved
 *     character id；所有 `__npc__保安` / `__npc__老板` 这类 ad-hoc dialogue
 *     在视觉层都映射到这个 id 查找立绘。
 *
 * 编辑器 character id 校验需要给该值开豁免（绕过 snake_case 起手字母规则），
 * 才能让作者在编辑器添加这个 character + 上传通用占位立绘。作者没添加该
 * character 时，ad-hoc dialogue 的立绘维持空台（不强制要求作者配置）。
 */
export const NPC_RESERVED_CHARACTER_ID = NPC_SPEAKER_PREFIX;

/** id 是否为 ad-hoc NPC（带 `__npc__` 前缀）。 */
export function isAdhocSpeaker(speakerId: string): boolean {
  return speakerId.startsWith(NPC_SPEAKER_PREFIX);
}

/**
 * 取 ad-hoc speaker 的显示名（前缀后的部分）。
 * 非 ad-hoc id 直接返回原值。后缀为空（裸 `__npc__`）也原样返回——
 * UI 自行决定怎么显示空名字。
 */
export function adhocDisplayName(speakerId: string): string {
  if (!isAdhocSpeaker(speakerId)) return speakerId;
  return speakerId.slice(NPC_SPEAKER_PREFIX.length);
}

/**
 * 中文代词 / 泛称黑名单。LLM 容易把 prompt 里 "`__npc__<显示名>`" 模板
 * 套用到第二人称代词上（典型错误：`speaker="__npc__你"`），结果 UI 渲染
 * 出一个名字叫"你"的 NPC 气泡。这些后缀都不是合法显示名。
 */
export const PRONOUN_DISPLAY_NAMES: ReadonlySet<string> = new Set([
  '你',
  '我',
  '他',
  '她',
  '它',
  '他们',
  '她们',
  '咱',
  '自己',
  '主角',
]);

/** ad-hoc speaker 的后缀是否是中文代词 / 泛称（不应作为角色 id）。 */
export function isPronounSpeaker(speakerId: string): boolean {
  if (!isAdhocSpeaker(speakerId)) return false;
  return PRONOUN_DISPLAY_NAMES.has(adhocDisplayName(speakerId));
}

// ============================================================================
// Degrade 事件名（分类一份）。和 Langfuse tag 对齐（RFC §10.1）。
// ============================================================================

/**
 * reducer 输出的事件分类。多数是 silent-degrade 类（语义降级），
 * `dialogue-adhoc-speaker` 是中性事件（量化用，非降级）。
 * `dialogue-pronoun-as-speaker` 是 ad-hoc 的细分子类——后缀是中文代词
 * （"你"/"我"/...），表明 LLM 把第二人称代词错当成 ad-hoc 显示名。
 *
 * 立绘相关事件在简化版规则下不再 emit（保留 enum 成员以便后续恢复 V.x
 * 视觉 IR 时无需 schema 演进）：
 * - `sprite-unknown-char` / `sprite-unknown-mood` / `stage-and-sprite-conflict`：
 *   旧版 inheritance 校验 `<sprite>` 子标签时触发，简化版整体忽略 `<sprite>`。
 * - `dialogue-speaker-sprite-fallback`：旧版兜底事件，简化版每个 dialogue
 *   都自动绑定 speaker 默认 sprite，不再需要"兜底"语义。
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
  | 'unknown-close-tag'
  | 'container-truncated'
  | 'dialogue-missing-speaker'
  | 'dialogue-unknown-speaker'
  | 'dialogue-adhoc-speaker'
  | 'dialogue-pronoun-as-speaker'
  | 'dialogue-speaker-sprite-fallback'
  | 'bare-text-outside-container';
