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
  `- 你的回复结束后，引擎会自动等待玩家输入（和聊天一样）。\n` +
  `- 叙事到达需要等待玩家的时刻时，正常结束你的回复即可。\n` +
  `- 可用 update_state 更新状态变量。\n` +
  `- 当需要玩家做选择时，**必须**调用 signal_input_needed 工具并在 choices 参数中提供选项列表。这会在玩家界面显示可点击的选项按钮。\n` +
  `- 输出只包含叙事正文和工具调用，不要输出计划、分析或元叙述。\n` +
  `---`;

export function assembleContext(options: AssembleOptions): AssembledContext {
  const {
    segments,
    stateStore,
    memory,
    tokenBudget,
    outputReserve = 4096,
    assemblyOrder,
  } = options;

  const availableBudget = tokenBudget - outputReserve;
  const vars = stateStore.getAll();
  let usedTokens = 0;

  // --- 1. Filter active segments by injection rules ---
  const activeSegments = segments.filter((seg) => {
    if (seg.role === 'draft') return false;
    if (!seg.injectionRule) return true;
    return evaluateCondition(seg.injectionRule.condition, vars);
  });

  // --- 2. Build named section content map ---
  // Each user segment gets its own ID; virtual sections use VIRTUAL_IDS
  const sectionContent = new Map<string, string>();
  const sectionTokens = new Map<string, number>();

  // User segments
  for (const seg of activeSegments) {
    sectionContent.set(seg.id, seg.content);
    sectionTokens.set(seg.id, seg.tokenCount);
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

  // Engine rules
  sectionContent.set(VIRTUAL_IDS.RULES, ENGINE_RULES_CONTENT);
  sectionTokens.set(VIRTUAL_IDS.RULES, estimateTokens(ENGINE_RULES_CONTENT));

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
