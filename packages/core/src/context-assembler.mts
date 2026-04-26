/**
 * ContextAssembler — Token 预算感知的 Prompt 组装
 *
 * 把剧本 segments + 引擎虚拟 section（state / focus / memory / rules）+
 * 历史 messages 组装成 LLM 的 systemPrompt + messages，按预算裁可裁段。
 *
 * 入口 `assembleContext` 6 步：computeBudget → filterActiveSegments →
 * buildAllSections → decideAssemblyOrder → packSectionsIntoBudget →
 * loadRecentHistory。每步都是同层级顶层函数，按 stepdown 展开细节。
 */

import type { ModelMessage } from 'ai';
import type {
  PromptSegment,
  FocusState,
  ProtocolVersion,
  CharacterAsset,
  BackgroundAsset,
} from '#internal/types';
import type { Memory } from '#internal/memory/types';
import type { StateStore } from '#internal/state-store';
import { serializeStateVars } from '#internal/state-store';
import { estimateTokens } from '#internal/tokens';
import { buildEngineRules } from '#internal/engine-rules';
import { rankSegments, scoreSegment } from '#internal/focus';
import { CURRENT_PROTOCOL_VERSION } from '#internal/protocol-version';

// ============================================================================
// Public types
// ============================================================================

export interface AssembledContext {
  systemPrompt: string;
  /**
   * AI SDK 原生 ModelMessage —— assistant 可带 ToolCallPart[]，tool role 带
   * ToolResultPart[]。让 LLM 看到自己过去 turn 调过哪些工具拿到什么结果（in-
   * context learning），不再是光秃秃的 narration。
   */
  messages: ModelMessage[];
  tokenBreakdown: TokenBreakdown;
}

export type { ModelMessage };

export interface TokenBreakdown {
  system: number;
  state: number;
  summaries: number;
  recentHistory: number;
  contextSegments: number;
  total: number;
  budget: number;
}

export interface AssembleOptions {
  segments: PromptSegment[];
  stateStore: StateStore;
  memory: Memory;
  tokenBudget: number;
  outputReserve?: number;
  initialPrompt?: string;
  /**
   * Memory.retrieve 的 query hint。由 game-session.buildRetrievalQuery() 生成。
   * Phase 1 简单返回最近玩家输入；未来可以升级为 LLM 动态生成检索 query 而不
   * 改本接口签名。空字符串合法（adapter 自己兜底）。
   */
  currentQuery: string;
  /**
   * 由 game-session 用 computeFocus(stateVars) 推断。生成 `_engine_scene_context`
   * section（焦点元信号 + top N 相关 segment IDs）。空 / 缺省 → 不生成此 section。
   */
  focus?: FocusState;
  assemblyOrder?: string[];
  disabledSections?: string[];
  /**
   * 'v2-declarative-visual'（缺省）→ 输出 `<dialogue>/<narration>/<background>/...`
   * 嵌套格式；'v1-tool-call' → 历史只读规则文本，供旧内容解析迁移使用。
   */
  protocolVersion?: ProtocolVersion;
  /**
   * 剧本白名单：character IDs + moods。v2 prompt 自动内联到规则里，提醒 LLM 只
   * 能用这些 ID（非白名单角色发言要转写到 narration，详见 RFC §12.1.1）。
   */
  characters?: ReadonlyArray<CharacterAsset>;
  /** 剧本白名单：background IDs。v2 prompt 自动内联。 */
  backgrounds?: ReadonlyArray<BackgroundAsset>;
}

// ============================================================================
// Internal types
// ============================================================================

type SectionCategory = 'system' | 'context' | 'state' | 'summary';

interface AssembledSection {
  readonly content: string;
  readonly tokens: number;
  /** Token-breakdown bucket the section's tokens are accounted to. */
  readonly category: SectionCategory;
  /** false → never trimmed by budget (system / state / rules). */
  readonly trimmable: boolean;
}

interface Budget {
  readonly tokenBudget: number;
  readonly outputReserve: number;
  readonly available: number;
}

interface SegmentFilterContext {
  readonly vars: Record<string, unknown>;
  readonly disabledIds: ReadonlySet<string>;
  readonly focus: FocusState | undefined;
  readonly focusFilterActive: boolean;
}

interface PackedPrompt {
  readonly systemPrompt: string;
  readonly breakdown: Record<SectionCategory, number>;
  readonly usedTokens: number;
}

interface RecentHistory {
  readonly messages: ModelMessage[];
  readonly tokensUsed: number;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * 引擎虚拟 section 的 ID 常量。编剧 segment 用自己的 id；引擎动态填充的
 * （state / memory / focus / rules / 首轮 prompt / 历史）用这些固定 ID。
 * context-assembler 和编辑器 PromptPreviewPanel 共享同一套定义。
 */
export const VIRTUAL_IDS = {
  STATE: '_engine_state',
  MEMORY: '_engine_memory',
  /** Focus Injection（focus.mts）：焦点元信号 + top N 相关 segment IDs */
  SCENE_CONTEXT: '_engine_scene_context',
  HISTORY: '_engine_history',
  RULES: '_engine_rules',
  INITIAL_PROMPT: '_initial_prompt',
} as const;

// ============================================================================
// Reused predicates / projections (exported for cross-module reuse)
// ============================================================================

/**
 * 把 state vars 解构成函数参数后 eval condition 字符串。支持 `==`/`!=`/比较
 * 运算符 / `&&` / `||` / `!`。失败（语法错或运行抛）一律返回 false。
 */
export function evaluateCondition(
  condition: string,
  vars: Record<string, unknown>,
): boolean {
  try {
    const keys = Object.keys(vars);
    const values = keys.map((k) => vars[k]);
    const fn = new Function(
      ...keys,
      `try { return !!(${condition}); } catch { return false; }`,
    );
    return fn(...values) as boolean;
  } catch {
    return false;
  }
}

/**
 * INTERNAL_STATE section 的完整文本。运行时和编辑器预览共用，确保 section
 * 分隔符 / 头部标签 / YAML 缩进字节级一致（曾因预览侧加 2 空格缩进而漂移）。
 */
export function buildStateSection(vars: Record<string, unknown>): string {
  const body = serializeStateVars(vars);
  return `---\nINTERNAL_STATE:\n${body}\n---`;
}

// ============================================================================
// assembleContext —— 6 步 stepdown，每步都是顶层函数
// ============================================================================

export async function assembleContext(options: AssembleOptions): Promise<AssembledContext> {
  const budget = computeBudget(options);
  const activeSegments = filterActiveSegments(options.segments, options);
  const sections = await buildAllSections(activeSegments, options);
  const orderedIds = decideAssemblyOrder(sections, activeSegments, options.assemblyOrder);
  const packed = packSectionsIntoBudget(orderedIds, sections, budget.available);
  const history = await loadRecentHistory(
    options.memory,
    budget.available - packed.usedTokens,
    options.initialPrompt,
  );
  return toAssembledContext(packed, history, budget);
}

// ----------------------------------------------------------------------------
// Step 1: budget
// ----------------------------------------------------------------------------

function computeBudget(options: AssembleOptions): Budget {
  const outputReserve = options.outputReserve ?? 4096;
  return {
    tokenBudget: options.tokenBudget,
    outputReserve,
    available: options.tokenBudget - outputReserve,
  };
}

// ----------------------------------------------------------------------------
// Step 2: filter active segments
// ----------------------------------------------------------------------------

/**
 * Focus Injection B2（.claude/plans/focus-injection.md）：
 *   - 无 focusTags 的 segment → 全局注入（world / rules / character cards）
 *   - 带 focusTags 的 segment → 只在 focus 命中时注入（scene / chars / stage 专属）
 *   - focus 缺省 / 空 → 不过滤（兼容老剧本无 current_scene 字段）
 */
function filterActiveSegments(
  segments: ReadonlyArray<PromptSegment>,
  options: AssembleOptions,
): PromptSegment[] {
  const ctx = buildSegmentFilterContext(options);
  return segments.filter((seg) => isSegmentActive(seg, ctx));
}

function buildSegmentFilterContext(options: AssembleOptions): SegmentFilterContext {
  const focus = options.focus;
  return {
    vars: options.stateStore.getAll(),
    disabledIds: new Set(options.disabledSections ?? []),
    focus,
    focusFilterActive: !!focus && Object.values(focus).some((v) => v !== undefined),
  };
}

function isSegmentActive(seg: PromptSegment, ctx: SegmentFilterContext): boolean {
  if (seg.role === 'draft') return false;
  if (ctx.disabledIds.has(seg.id)) return false;
  if (seg.injectionRule && !evaluateCondition(seg.injectionRule.condition, ctx.vars)) return false;
  if (ctx.focusFilterActive && seg.focusTags) return scoreSegment(seg, ctx.focus!) > 0;
  return true;
}

// ----------------------------------------------------------------------------
// Step 3: build sections (user + virtual)
// ----------------------------------------------------------------------------

async function buildAllSections(
  activeSegments: ReadonlyArray<PromptSegment>,
  options: AssembleOptions,
): Promise<Map<string, AssembledSection>> {
  const disabledIds = new Set(options.disabledSections ?? []);
  const userSections = activeSegments.map(buildUserSegmentSection);
  const virtualSections = await buildVirtualSections(activeSegments, options, disabledIds);
  return new Map([...userSections, ...virtualSections]);
}

/**
 * 每段用 `--- [${label}] ---\n<body>` 包裹，作为 Focus Injection 的 ID 锚点
 * —— `_engine_scene_context` 里提到的 segment ID/label 让 LLM 能找到对应段落。
 */
function buildUserSegmentSection(seg: PromptSegment): [string, AssembledSection] {
  const body = (seg.useDerived && seg.derivedContent) ? seg.derivedContent : seg.content;
  const content = `--- [${seg.label || seg.id}] ---\n${body}`;
  const isSystem = seg.role === 'system';
  return [seg.id, buildSection(content, isSystem ? 'system' : 'context', !isSystem)];
}

async function buildVirtualSections(
  activeSegments: ReadonlyArray<PromptSegment>,
  options: AssembleOptions,
  disabledIds: ReadonlySet<string>,
): Promise<Array<[string, AssembledSection]>> {
  const memorySection = await buildMemorySection(options.memory, options.currentQuery);
  const candidates: Array<[string, AssembledSection | null]> = [
    [VIRTUAL_IDS.STATE, buildStateVarsSection(options.stateStore)],
    [VIRTUAL_IDS.SCENE_CONTEXT, buildFocusSection(options.focus, activeSegments)],
    [VIRTUAL_IDS.MEMORY, memorySection],
    [VIRTUAL_IDS.RULES, buildRulesSection(
      options.protocolVersion ?? CURRENT_PROTOCOL_VERSION,
      options.characters ?? [],
      options.backgrounds ?? [],
    )],
  ];
  return candidates.filter(
    (e): e is [string, AssembledSection] => e[1] !== null && !disabledIds.has(e[0]),
  );
}

function buildStateVarsSection(stateStore: StateStore): AssembledSection {
  return buildSection(buildStateSection(stateStore.getAll()), 'state', false);
}

/**
 * Focus 元信号 + 命中段落清单。focus 全空 → null（不生成）。命中段落数为 0
 * 时仍输出焦点头，让 LLM 知道"当前在某场景但无专属内容"。
 */
function buildFocusSection(
  focus: FocusState | undefined,
  activeSegments: ReadonlyArray<PromptSegment>,
): AssembledSection | null {
  if (!focus) return null;
  const focusLines = focusToLines(focus);
  if (focusLines.length === 0) return null;

  const ranked = rankSegments([...activeSegments], focus, 5);
  const relevantLines = ranked.length > 0
    ? ['', 'Most relevant segments:', ...ranked.map((s) => ` - ${s.label || s.id}`)]
    : [];
  const body = ['[Current Focus]', ...focusLines, ...relevantLines].join('\n');
  return buildSection(`---\n${body}\n---`, 'system', true);
}

function focusToLines(focus: FocusState): string[] {
  // v2: characters / stage
  return [focus.scene ? `scene: ${focus.scene}` : undefined].filter(
    (line): line is string => line !== undefined,
  );
}

/**
 * Memory.retrieve 产出 summaries + pinned（legacy）/ 向量检索结果（mem0）。
 * summary 为空字符串时返回 null，section 不进 prompt。
 */
async function buildMemorySection(
  memory: Memory,
  query: string,
): Promise<AssembledSection | null> {
  const retrieval = await memory.retrieve(query);
  if (!retrieval.summary) return null;
  return buildSection(`---\n[Memory Summary]\n${retrieval.summary}\n---`, 'summary', true);
}

function buildRulesSection(
  _protocolVersion: ProtocolVersion,
  characters: ReadonlyArray<CharacterAsset>,
  backgrounds: ReadonlyArray<BackgroundAsset>,
): AssembledSection {
  // protocolVersion 不再用于 prompt 装配（buildEngineRules 永远产 v2）；保留
  // 参数签名是为了 caller 不必同步改——legacy v1 协议的 runtime 守门在
  // game-session 层做（拒绝执行），不在这里。
  return buildSection(
    buildEngineRules({ characters, backgrounds }),
    'system',
    false,
  );
}

function buildSection(
  content: string,
  category: SectionCategory,
  trimmable: boolean,
): AssembledSection {
  return { content, tokens: estimateTokens(content), category, trimmable };
}

// ----------------------------------------------------------------------------
// Step 4: assembly order
// ----------------------------------------------------------------------------

function decideAssemblyOrder(
  sections: ReadonlyMap<string, AssembledSection>,
  activeSegments: ReadonlyArray<PromptSegment>,
  customOrder: ReadonlyArray<string> | undefined,
): string[] {
  const ordered = customOrder?.length
    ? applyCustomOrder(customOrder, sections)
    : defaultOrder(sections, activeSegments);
  // history / initial_prompt 走 messages 不进 systemPrompt 顺序
  return ordered.filter(
    (id) => id !== VIRTUAL_IDS.HISTORY && id !== VIRTUAL_IDS.INITIAL_PROMPT,
  );
}

function applyCustomOrder(
  customOrder: ReadonlyArray<string>,
  sections: ReadonlyMap<string, AssembledSection>,
): string[] {
  const inCustom = new Set(customOrder);
  return [
    ...customOrder.filter((id) => sections.has(id)),
    ...Array.from(sections.keys()).filter((id) => !inCustom.has(id)),
  ];
}

/** 默认顺序：system segs → state → focus → memory → context segs → rules */
function defaultOrder(
  sections: ReadonlyMap<string, AssembledSection>,
  activeSegments: ReadonlyArray<PromptSegment>,
): string[] {
  const segmentIdsByRole = (role: PromptSegment['role']): string[] =>
    activeSegments
      .filter((s) => s.role === role)
      .sort((a, b) => a.priority - b.priority)
      .map((s) => s.id);
  const includeIfPresent = (id: string): string[] => sections.has(id) ? [id] : [];

  return [
    ...segmentIdsByRole('system'),
    ...includeIfPresent(VIRTUAL_IDS.STATE),
    ...includeIfPresent(VIRTUAL_IDS.SCENE_CONTEXT),
    ...includeIfPresent(VIRTUAL_IDS.MEMORY),
    ...segmentIdsByRole('context'),
    ...includeIfPresent(VIRTUAL_IDS.RULES),
  ];
}

// ----------------------------------------------------------------------------
// Step 5: pack into budget
//
// AGENTS.md 明确说"token-budget trimming with early exit"保留命令式：for 循环
// 顺序遍历 + 早退判断 + 累加器，比 reduce 链更直观。
// ----------------------------------------------------------------------------

function packSectionsIntoBudget(
  orderedIds: ReadonlyArray<string>,
  sections: ReadonlyMap<string, AssembledSection>,
  available: number,
): PackedPrompt {
  const lines: string[] = [];
  const breakdown: Record<SectionCategory, number> = { system: 0, context: 0, state: 0, summary: 0 };
  let usedTokens = 0;

  for (const id of orderedIds) {
    const section = sections.get(id);
    if (!section) continue;
    if (section.trimmable && usedTokens + section.tokens > available) continue;
    lines.push(section.content);
    usedTokens += section.tokens;
    breakdown[section.category] += section.tokens;
  }

  return { systemPrompt: lines.join('\n\n'), breakdown, usedTokens };
}

// ----------------------------------------------------------------------------
// Step 6: load recent history
// ----------------------------------------------------------------------------

/**
 * 历史 messages 走 Memory adapter；空 history 时用 initialPrompt 兜底（AI SDK
 * 要求 messages 至少一条，是接口侧约束不归 Memory 管）。
 */
async function loadRecentHistory(
  memory: Memory,
  budget: number,
  initialPrompt: string | undefined,
): Promise<RecentHistory> {
  const { messages, tokensUsed } = await memory.getRecentAsMessages({ budget });
  if (messages.length > 0) return { messages, tokensUsed };
  return {
    messages: [{
      role: 'user',
      content: initialPrompt ?? '[Game session started. Begin narration.]',
    }],
    tokensUsed: 0,
  };
}

// ----------------------------------------------------------------------------
// Step 7: shape return
// ----------------------------------------------------------------------------

function toAssembledContext(
  packed: PackedPrompt,
  history: RecentHistory,
  budget: Budget,
): AssembledContext {
  return {
    systemPrompt: packed.systemPrompt,
    messages: history.messages,
    tokenBreakdown: {
      system: packed.breakdown.system,
      state: packed.breakdown.state,
      summaries: packed.breakdown.summary,
      contextSegments: packed.breakdown.context,
      recentHistory: history.tokensUsed,
      total: packed.usedTokens + history.tokensUsed,
      budget: budget.available,
    },
  };
}
