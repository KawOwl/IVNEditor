/**
 * ContextAssembler — Token 预算感知的 Prompt 组装
 *
 * 根据当前状态、记忆、Prompt Segments，组装 LLM 的输入 messages。
 * 按优先级填充，超出 token 预算时裁剪低优先级内容。
 *
 * 优先级顺序：
 *   1. System segments (role='system', 不可裁)
 *   2. State YAML snapshot
 *   3. Memory summaries (含 inheritedSummary)
 *   4. Recent history
 *   5. Context segments (role='context', 可裁)
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
// Types
// ============================================================================

export interface AssembledContext {
  systemPrompt: string;
  /**
   * 对话历史。AI SDK 原生 ModelMessage —— assistant 可带 ToolCallPart[]，
   * tool role 带 ToolResultPart[]。这样 LLM 能看到自己过去 turn 调了什么
   * 工具、拿到什么结果（in-context learning 的教材），而不是只看到光秃秃
   * 的 narration。
   *
   * 2026-04-24 之前这里是本地 `{ role, content: string }`，
   * 装不下 tool-call parts —— legacy adapter 把 tool_call / signal_input
   * entries 过滤掉了，LLM 每一 turn 看到的历史都像从没开过工具。切成
   * ModelMessage 后，messages-builder 能正确投影 tool history 到消息流。
   */
  messages: ModelMessage[];
  tokenBreakdown: TokenBreakdown;
}

// Re-export so消费者 `import type { ModelMessage } from '…/context-assembler'` 也 work
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
  outputReserve?: number;   // tokens reserved for LLM output (default: 4096)
  initialPrompt?: string;   // 首轮 user message（等效于 prompt.txt）
  /**
   * Memory.retrieve 的 query hint。
   *
   * 由 game-session.buildRetrievalQuery() 生成 —— 这是个**刻意的扩展点**，
   * Phase 1 简单返回最近玩家输入；未来可以升级为 LLM 动态生成检索 query，
   * 升级时 assembleContext / Memory.retrieve 的签名不变。
   *
   * 空字符串合法：adapter 自己兜底（legacy → entries 空数组；mem0 按策略）。
   */
  currentQuery: string;
  /**
   * 当前 focus 状态，由 game-session 通过 computeFocus(stateVars) 推断传入。
   * 用于生成 `_engine_scene_context` section（focus 元信号 + top N 相关 segment IDs）。
   * 省略或空对象 → section 不生成，向后兼容。
   */
  focus?: FocusState;
  assemblyOrder?: string[]; // 自定义组装顺序（section ID 列表，含虚拟 section）
  disabledSections?: string[]; // 被禁用的 section ID 列表（不参与组装）
  /**
   * 声明式视觉 IR 协议版本。
   *   - 'v2-declarative-visual'（缺省运行协议）→ 输出
   *     `<dialogue>/<narration>/<background>/<sprite>/<stage>/<scratch>` 嵌套格式
   *   - 'v1-tool-call' → 历史只读规则文本，供旧内容解析/迁移使用
   */
  protocolVersion?: ProtocolVersion;
  /**
   * 剧本白名单：character IDs + moods。v2 prompt 自动内联到规则里，提醒 LLM 只能
   * 使用这些 ID；非白名单角色发言要转写到 `<narration>` 旁白（RFC §12.1.1）。
   * 缺省空数组 → prompt 里显示"（无预置角色）"。
   */
  characters?: ReadonlyArray<CharacterAsset>;
  /**
   * 剧本白名单：background IDs。v2 prompt 自动内联。
   */
  backgrounds?: ReadonlyArray<BackgroundAsset>;
}

// ============================================================================
// Condition Evaluator
// ============================================================================

/**
 * Simple condition evaluator for injection rules.
 * Evaluates expressions like "state.current_stage == 'exploration'"
 * against the current state variables.
 */
function evaluateCondition(
  condition: string,
  vars: Record<string, unknown>,
): boolean {
  try {
    // Create a simple evaluator with state vars in scope
    // Supports: ==, !=, >, <, >=, <=, &&, ||, !
    // Destructure state vars into local scope so conditions like
    // "chapter === 1" work without needing "state.chapter === 1"
    const keys = Object.keys(vars);
    const values = keys.map((k) => vars[k]);
    const fn = new Function(
      ...keys,
      `try { return !!(${condition}); } catch { return false; }`,
    );
    return fn(...values) as boolean;
  } catch {
    // If evaluation fails, treat as false (don't inject)
    return false;
  }
}

// ============================================================================
// ContextAssembler
// ============================================================================

/**
 * 引擎虚拟 section 的 ID 常量。
 *
 * 编剧创建的 segment 使用自己的 id；引擎动态填充的内容（状态、记忆、历史、
 * 规则、首轮 prompt）则使用这些固定 ID，供 context-assembler 和编辑器
 * PromptPreviewPanel 共享同一套"虚拟 section"定义。
 */
export const VIRTUAL_IDS = {
  STATE: '_engine_state',
  MEMORY: '_engine_memory',
  /** Focus Injection（见 src/core/focus.ts）：focus 元信号 + top N 相关 segment IDs */
  SCENE_CONTEXT: '_engine_scene_context',
  HISTORY: '_engine_history',
  RULES: '_engine_rules',
  INITIAL_PROMPT: '_initial_prompt',
} as const;

/**
 * 构建 INTERNAL_STATE section 的完整文本。
 *
 * 运行时和编辑器预览都用这个函数，确保两侧的 section 分隔符、头部标签、
 * YAML 缩进风格完全一致，不会再出现"预览里带 2 空格缩进而运行时不带"
 * 这类漂移。
 */
export function buildStateSection(vars: Record<string, unknown>): string {
  const body = serializeStateVars(vars);
  return `---\nINTERNAL_STATE:\n${body}\n---`;
}

// ENGINE_RULES_CONTENT 现在在 ./engine-rules.ts 单独维护，
// 玩家侧运行时 + 编剧侧 AI 改写都从那里 import，保持单一真源。

type SectionCategory = 'system' | 'context' | 'state' | 'summary';

interface AssembledSection {
  readonly content: string;
  readonly tokens: number;
  /** Token-breakdown bucket the section's tokens are accounted to. */
  readonly category: SectionCategory;
  /** false → never trimmed by budget (system / state / rules). */
  readonly trimmable: boolean;
}

export async function assembleContext(options: AssembleOptions): Promise<AssembledContext> {
  const {
    segments,
    stateStore,
    memory,
    tokenBudget,
    outputReserve = 4096,
    currentQuery,
    focus,
    assemblyOrder,
    disabledSections,
    protocolVersion = CURRENT_PROTOCOL_VERSION,
    characters = [],
    backgrounds = [],
  } = options;

  const availableBudget = tokenBudget - outputReserve;
  const vars = stateStore.getAll();
  let usedTokens = 0;
  const disabledSet = new Set(disabledSections ?? []);

  // --- 1. Filter active segments by injection rules + disabled list + focus (B2) ---
  //
  // Focus Injection B2（见 .claude/plans/focus-injection.md 升级路径）：
  //   - 无 focusTags 的 segment  → 全局注入，不受 focus 影响（world/rules/character cards）
  //   - 有 focusTags 的 segment  → 只在当前 focus 命中时注入（scene/chars/stage 专属内容）
  //   - focus 缺省或空 → 不过滤（向后兼容；老剧本没 current_scene 字段时走老逻辑）
  //
  // 效果：大剧本里非当前 scene 的 scene 段不再占预算。
  const focusFilterActive = !!focus && Object.values(focus).some((v) => v !== undefined);
  const activeSegments = segments.filter((seg) => {
    if (seg.role === 'draft') return false;
    if (disabledSet.has(seg.id)) return false;
    if (seg.injectionRule && !evaluateCondition(seg.injectionRule.condition, vars)) return false;
    if (focusFilterActive && seg.focusTags) {
      return scoreSegment(seg, focus!) > 0;
    }
    return true;
  });

  // --- 2. Build named section map ---
  //
  // Each user segment gets its own ID; virtual sections use VIRTUAL_IDS.
  // 每段用 `--- [${label}] ---\n<body>` 包裹，作为 Focus Injection 的 ID
  // 锚点 —— `_engine_scene_context` 里提到的 segment ID/label 能让 LLM 找到
  // 对应段落。label 为空时 fallback 到 id。
  //
  // category + trimmable 在 section 创建处一并定下来，consumption 阶段直接读
  // 字段，不再按 id 走 if/else 链回查身份。
  const sections = new Map<string, AssembledSection>();
  const addSection = (id: string, content: string, category: SectionCategory, trimmable: boolean): void => {
    sections.set(id, { content, tokens: estimateTokens(content), category, trimmable });
  };

  for (const seg of activeSegments) {
    const body = (seg.useDerived && seg.derivedContent) ? seg.derivedContent : seg.content;
    const content = `--- [${seg.label || seg.id}] ---\n${body}`;
    addSection(
      seg.id,
      content,
      seg.role === 'system' ? 'system' : 'context',
      seg.role !== 'system',
    );
  }

  // State YAML (can be disabled). Not trimmed.
  if (!disabledSet.has(VIRTUAL_IDS.STATE)) {
    addSection(VIRTUAL_IDS.STATE, buildStateSection(stateStore.getAll()), 'state', false);
  }

  // Focus Injection（见 src/core/focus.ts 和 .claude/plans/focus-injection.md）
  //
  // 放在 STATE 之后、MEMORY 之前 —— 给 LLM 先呈现"此刻在哪、关注谁/啥"的
  // focus 元信号，再让它看 memory 里相关记忆。
  //
  // B2 模式：step 1 已按 focus 过滤 activeSegments，本段只剩"元信号 + 实际注入
  // 的匹配段落列表"。ranked 和 activeSegments 里带 focusTags 的那部分重合。
  //
  // 生成条件：focus 有效（至少一维有值）即生成。即使无 segment 匹配当前 focus，
  // 也输出 focus 头（scene: xxx），让 LLM 明确知道"在某个场景，但没专属内容"。
  // tokens 计入 system bucket，但是 trimmable（高预算压力下可以丢）。
  if (!disabledSet.has(VIRTUAL_IDS.SCENE_CONTEXT) && focus) {
    const focusLines = [
      focus.scene ? `scene: ${focus.scene}` : undefined,
    ].filter((line): line is string => line !== undefined);
    // v2: characters / stage
    if (focusLines.length > 0) {
      const ranked = rankSegments(activeSegments, focus, 5);
      const relevantLines = ranked.length > 0
        ? ['', 'Most relevant segments:', ...ranked.map((s) => ` - ${s.label || s.id}`)]
        : [];
      const lines = ['[Current Focus]', ...focusLines, ...relevantLines];
      addSection(VIRTUAL_IDS.SCENE_CONTEXT, `---\n${lines.join('\n')}\n---`, 'system', true);
    }
  }

  // Memory summaries (can be disabled). Trimmable.
  // 内容由 Memory.retrieve 产出：legacy 下是 summaries + pinned（修复了原 bug：
  // pinned entries 原本漏读不在 section 里）；mem0 下是向量检索的相关记忆。
  if (!disabledSet.has(VIRTUAL_IDS.MEMORY)) {
    const retrieval = await memory.retrieve(currentQuery);
    if (retrieval.summary) {
      addSection(VIRTUAL_IDS.MEMORY, `---\n[Memory Summary]\n${retrieval.summary}\n---`, 'summary', true);
    }
  }

  // Engine rules (can be disabled). Not trimmed.
  if (!disabledSet.has(VIRTUAL_IDS.RULES)) {
    addSection(
      VIRTUAL_IDS.RULES,
      buildEngineRules({ protocolVersion, characters, backgrounds }),
      'system',
      false,
    );
  }

  // --- 3. Determine assembly order ---
  let orderedIds: string[];
  if (assemblyOrder && assemblyOrder.length > 0) {
    // Use custom order, filtering to only existing sections, then append
    // any new sections not mentioned in the custom order.
    const existingIds = Array.from(sections.keys());
    const customOrder = assemblyOrder.filter((id) => sections.has(id));
    const customOrderSet = new Set(customOrder);
    orderedIds = [
      ...customOrder,
      ...existingIds.filter((id) => !customOrderSet.has(id)),
    ];
  } else {
    // Default order: system segs → state → focus → memory → context segs → rules
    const systemSegs = activeSegments
      .filter((s) => s.role === 'system')
      .sort((a, b) => a.priority - b.priority);
    const contextSegs = activeSegments
      .filter((s) => s.role === 'context')
      .sort((a, b) => a.priority - b.priority);
    // 只把实际 set 进来的虚拟 section 列入默认顺序（被 disabled 的不在 sections 里）
    const virtualIfPresent = (id: string): string[] => sections.has(id) ? [id] : [];
    orderedIds = [
      ...systemSegs.map((s) => s.id),
      ...virtualIfPresent(VIRTUAL_IDS.STATE),
      ...virtualIfPresent(VIRTUAL_IDS.SCENE_CONTEXT),
      ...virtualIfPresent(VIRTUAL_IDS.MEMORY),
      ...contextSegs.map((s) => s.id),
      ...virtualIfPresent(VIRTUAL_IDS.RULES),
    ];
  }

  // Remove history and initial_prompt from system prompt ordering
  // (they are handled as messages, not system prompt sections)
  orderedIds = orderedIds.filter(
    (id) => id !== VIRTUAL_IDS.HISTORY && id !== VIRTUAL_IDS.INITIAL_PROMPT,
  );

  // --- 4. Assemble system prompt following order, respecting budget ---
  const systemPromptSections: string[] = [];
  const breakdown: Record<SectionCategory, number> = { system: 0, context: 0, state: 0, summary: 0 };

  for (const id of orderedIds) {
    const section = sections.get(id);
    if (!section) continue;
    if (section.trimmable && usedTokens + section.tokens > availableBudget) continue;

    systemPromptSections.push(section.content);
    usedTokens += section.tokens;
    breakdown[section.category] += section.tokens;
  }

  const systemPrompt = systemPromptSections.join('\n\n');

  // --- 5. Recent history (always after system prompt, as messages) ---
  // role 翻译 + budget cap 的职责从这里挪进 Memory adapter 内部，
  // assembler 一行调用拿到 ModelMessage[]。
  const budgetRemaining = availableBudget - usedTokens;
  const { messages: historyMessages, tokensUsed: historyTokens } =
    await memory.getRecentAsMessages({ budget: budgetRemaining });
  usedTokens += historyTokens;

  // AI SDK requires at least one message — use initialPrompt or fallback
  // 这是对 AI SDK "messages 不能为空" 约束的兜底，不归 Memory 接口管。
  const messages: ModelMessage[] = historyMessages.length > 0
    ? historyMessages
    : [{
        role: 'user',
        content: options.initialPrompt ?? '[Game session started. Begin narration.]',
      }];

  return {
    systemPrompt,
    messages,
    tokenBreakdown: {
      system: breakdown.system,
      state: breakdown.state,
      summaries: breakdown.summary,
      recentHistory: historyTokens,
      contextSegments: breakdown.context,
      total: usedTokens,
      budget: availableBudget,
    },
  };
}

export { evaluateCondition };
