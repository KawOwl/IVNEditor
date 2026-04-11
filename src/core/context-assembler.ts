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

import type {
  PromptSegment,
} from './types';
import type { MemoryManager } from './memory';
import type { StateStore } from './state-store';
import { estimateTokens } from './memory';

// ============================================================================
// Types
// ============================================================================

export interface AssembledContext {
  systemPrompt: string;
  messages: ChatMessage[];
  tokenBreakdown: TokenBreakdown;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

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
  memory: MemoryManager;
  tokenBudget: number;
  outputReserve?: number;   // tokens reserved for LLM output (default: 4096)
  initialPrompt?: string;   // 首轮 user message（等效于 prompt.txt）
  assemblyOrder?: string[]; // 自定义组装顺序（section ID 列表，含虚拟 section）
  disabledSections?: string[]; // 被禁用的 section ID 列表（不参与组装）
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

// Virtual section IDs (must match PromptPreviewPanel)
const VIRTUAL_IDS = {
  STATE: '_engine_state',
  MEMORY: '_engine_memory',
  HISTORY: '_engine_history',
  RULES: '_engine_rules',
  INITIAL_PROMPT: '_initial_prompt',
} as const;

const ENGINE_RULES_CONTENT =
  `---\n[ENGINE RULES]\n` +
  `你运行在互动叙事引擎中。你是GM，不是玩家。\n` +
  `- 绝对不要替玩家行动、观察、思考或说话。\n` +
  `- 可用 update_state 更新状态变量。\n` +
  `- 输出只包含叙事正文和工具调用，不要输出计划、分析或元叙述。\n` +
  `\n## 回合收尾规则（硬性）\n` +
  `每次回复在叙事正文写完后，**必须**在下列两种收尾之一里选一个，不允许"空停"（既不调 signal_input_needed 也没有任何后续动作）：\n` +
  `\n` +
  `**A. 调用 signal_input_needed**（下列任一命中时必须选此项）：\n` +
  `1. 剧本 prompt 明确要求提供选项；\n` +
  `2. 叙事到达分支点——玩家面临多条行动路线（如：战斗/逃跑/谈判、前往A/前往B、答应/拒绝）；\n` +
  `3. NPC 向玩家提问或提出要求，需要玩家回应；\n` +
  `4. 场景描述完毕，玩家需要决定下一步行动；\n` +
  `5. 对话中出现立场分歧，玩家需要表态。\n` +
  `\n` +
  `**B. 自然结束回复**（仅当：玩家正在自由探索、描述具体行为细节、或当前场景更适合开放式独白时）。\n` +
  `\n## signal_input_needed 工具说明\n` +
  `此工具的作用：在叙事正文结束后，向玩家界面**同时**呈现两种输入方式——\n` +
  `- **可点击的选项按钮**：由 choices 参数提供的 2-4 条，玩家点一下即作为回复\n` +
  `- **自由输入框**：玩家可以忽略按钮，直接输入任何行动/对话/想法\n` +
  `\n` +
  `所以 choices 是"建议的快捷选项"，不是"限定选项"——玩家永远可以自由输入，调用此工具不会剥夺玩家的自由回复权。反过来说，既然自由输入一直存在，你也应当在情境合适时积极提供选项按钮，降低玩家的决策负担。\n` +
  `\n` +
  `**choices 参数的填法：**\n` +
  `- 如果剧本 prompt 里已经给出固定的选项集合，**原样**按剧本提供的文字填入，不要改写、不要增减；\n` +
  `- 否则由你根据当前情境生成 2-4 个选项：\n` +
  `  - 每个不超过 15 字，代表不同的行动或态度方向；\n` +
  `  - 至少包含一个有创意或大胆的选项，不要全是保守选择；\n` +
  `  - 让玩家感到自己的选择会影响故事走向。\n` +
  `---`;

export function assembleContext(options: AssembleOptions): AssembledContext {
  const {
    segments,
    stateStore,
    memory,
    tokenBudget,
    outputReserve = 4096,
    assemblyOrder,
    disabledSections,
  } = options;

  const availableBudget = tokenBudget - outputReserve;
  const vars = stateStore.getAll();
  let usedTokens = 0;
  const disabledSet = new Set(disabledSections ?? []);

  // --- 1. Filter active segments by injection rules + disabled list ---
  const activeSegments = segments.filter((seg) => {
    if (seg.role === 'draft') return false;
    if (disabledSet.has(seg.id)) return false;
    if (!seg.injectionRule) return true;
    return evaluateCondition(seg.injectionRule.condition, vars);
  });

  // --- 2. Build named section content map ---
  // Each user segment gets its own ID; virtual sections use VIRTUAL_IDS
  const sectionContent = new Map<string, string>();
  const sectionTokens = new Map<string, number>();

  // User segments (use derivedContent if useDerived)
  for (const seg of activeSegments) {
    const content = (seg.useDerived && seg.derivedContent) ? seg.derivedContent : seg.content;
    const tokens = estimateTokens(content);
    sectionContent.set(seg.id, content);
    sectionTokens.set(seg.id, tokens);
  }

  // State YAML
  const stateYaml = stateStore.serialize();
  const stateSection = `---\nINTERNAL_STATE:\n${stateYaml}\n---`;
  const stateTokenCount = estimateTokens(stateYaml);
  sectionContent.set(VIRTUAL_IDS.STATE, stateSection);
  sectionTokens.set(VIRTUAL_IDS.STATE, stateTokenCount);

  // Memory summaries
  const summaryParts: string[] = [];
  const inherited = memory.getInheritedSummary();
  if (inherited) summaryParts.push(`[Previous Chapter Summary]\n${inherited}`);
  for (const summary of memory.getSummaries()) summaryParts.push(summary);
  const summaryContent = summaryParts.length > 0
    ? `---\n[Memory Summary]\n${summaryParts.join('\n\n')}\n---`
    : '';
  const summaryTokenCount = summaryContent ? estimateTokens(summaryContent) : 0;
  if (summaryContent) {
    sectionContent.set(VIRTUAL_IDS.MEMORY, summaryContent);
    sectionTokens.set(VIRTUAL_IDS.MEMORY, summaryTokenCount);
  }

  // Engine rules (can be disabled)
  if (!disabledSet.has(VIRTUAL_IDS.RULES)) {
    sectionContent.set(VIRTUAL_IDS.RULES, ENGINE_RULES_CONTENT);
    sectionTokens.set(VIRTUAL_IDS.RULES, estimateTokens(ENGINE_RULES_CONTENT));
  }

  // --- 3. Determine assembly order ---
  let orderedIds: string[];
  if (assemblyOrder && assemblyOrder.length > 0) {
    // Use custom order, filtering to only existing sections
    const existing = new Set(sectionContent.keys());
    orderedIds = assemblyOrder.filter((id) => existing.has(id));
    // Append any new sections not in custom order
    for (const id of sectionContent.keys()) {
      if (!orderedIds.includes(id)) orderedIds.push(id);
    }
  } else {
    // Default order: system segs → state → memory → context segs → rules
    const systemSegs = activeSegments
      .filter((s) => s.role === 'system')
      .sort((a, b) => a.priority - b.priority);
    const contextSegs = activeSegments
      .filter((s) => s.role === 'context')
      .sort((a, b) => a.priority - b.priority);
    orderedIds = [
      ...systemSegs.map((s) => s.id),
      VIRTUAL_IDS.STATE,
      ...(summaryContent ? [VIRTUAL_IDS.MEMORY] : []),
      ...contextSegs.map((s) => s.id),
      VIRTUAL_IDS.RULES,
    ];
  }

  // Remove history and initial_prompt from system prompt ordering
  // (they are handled as messages, not system prompt sections)
  orderedIds = orderedIds.filter(
    (id) => id !== VIRTUAL_IDS.HISTORY && id !== VIRTUAL_IDS.INITIAL_PROMPT,
  );

  // --- 4. Assemble system prompt following order, respecting budget ---
  const systemPromptSections: string[] = [];
  let systemTokens = 0;
  let contextTokens = 0;
  let stateTokensFinal = 0;
  let summaryTokensFinal = 0;

  for (const id of orderedIds) {
    const content = sectionContent.get(id);
    const tokens = sectionTokens.get(id) ?? 0;
    if (!content) continue;

    // System segments and engine rules are not trimmed
    const seg = activeSegments.find((s) => s.id === id);
    const isSystemOrRules = (seg?.role === 'system') || id === VIRTUAL_IDS.RULES || id === VIRTUAL_IDS.STATE;

    if (!isSystemOrRules && usedTokens + tokens > availableBudget) continue;

    systemPromptSections.push(content);
    usedTokens += tokens;

    // Track token categories
    if (seg?.role === 'system') systemTokens += tokens;
    else if (seg?.role === 'context') contextTokens += tokens;
    else if (id === VIRTUAL_IDS.STATE) stateTokensFinal = tokens;
    else if (id === VIRTUAL_IDS.MEMORY) summaryTokensFinal = tokens;
    else if (id === VIRTUAL_IDS.RULES) systemTokens += tokens;
  }

  const systemPrompt = systemPromptSections.join('\n\n');

  // --- 5. Recent history (always after system prompt, as messages) ---
  let historyTokens = 0;
  const recentEntries = memory.getRecent();
  const historyMessages: ChatMessage[] = [];

  for (const entry of recentEntries) {
    if (usedTokens + entry.tokenCount > availableBudget) break;
    historyMessages.push({
      role: entry.role === 'receive' ? 'user' : 'assistant',
      content: entry.content,
    });
    historyTokens += entry.tokenCount;
    usedTokens += entry.tokenCount;
  }

  // AI SDK requires at least one message — use initialPrompt or fallback
  if (historyMessages.length === 0) {
    historyMessages.push({
      role: 'user',
      content: options.initialPrompt ?? '[Game session started. Begin narration.]',
    });
  }

  return {
    systemPrompt,
    messages: historyMessages,
    tokenBreakdown: {
      system: systemTokens,
      state: stateTokensFinal,
      summaries: summaryTokensFinal,
      recentHistory: historyTokens,
      contextSegments: contextTokens,
      total: usedTokens,
      budget: availableBudget,
    },
  };
}

export { evaluateCondition };
