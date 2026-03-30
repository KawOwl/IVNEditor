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
    const fn = new Function(
      'state',
      `try { return !!(${condition}); } catch { return false; }`,
    );
    return fn(vars) as boolean;
  } catch {
    // If evaluation fails, treat as false (don't inject)
    return false;
  }
}

// ============================================================================
// ContextAssembler
// ============================================================================

export function assembleContext(options: AssembleOptions): AssembledContext {
  const {
    segments,
    stateStore,
    memory,
    tokenBudget,
    outputReserve = 4096,
  } = options;

  const availableBudget = tokenBudget - outputReserve;
  const vars = stateStore.getAll();
  let usedTokens = 0;

  // --- 1. Filter and sort segments by injection rules ---
  const activeSegments = segments.filter((seg) => {
    if (!seg.injectionRule) return true; // no rule = always inject
    return evaluateCondition(seg.injectionRule.condition, vars);
  });

  const systemSegments = activeSegments
    .filter((s) => s.role === 'system')
    .sort((a, b) => a.priority - b.priority);

  const contextSegments = activeSegments
    .filter((s) => s.role === 'context')
    .sort((a, b) => a.priority - b.priority);

  // --- 2. System segments (not trimmed) ---
  const systemParts: string[] = [];
  let systemTokens = 0;
  for (const seg of systemSegments) {
    systemParts.push(seg.content);
    systemTokens += seg.tokenCount;
  }
  usedTokens += systemTokens;

  // --- 3. State YAML ---
  const stateYaml = stateStore.serialize();
  const stateTokens = estimateTokens(stateYaml);
  const stateSection = `---\nINTERNAL_STATE:\n${stateYaml}\n---`;
  usedTokens += stateTokens;

  // --- 4. Memory summaries ---
  let summaryTokens = 0;
  const summaryParts: string[] = [];

  const inherited = memory.getInheritedSummary();
  if (inherited) {
    const tokens = estimateTokens(inherited);
    if (usedTokens + tokens <= availableBudget) {
      summaryParts.push(`[Previous Chapter Summary]\n${inherited}`);
      summaryTokens += tokens;
      usedTokens += tokens;
    }
  }

  for (const summary of memory.getSummaries()) {
    const tokens = estimateTokens(summary);
    if (usedTokens + tokens > availableBudget) break;
    summaryParts.push(summary);
    summaryTokens += tokens;
    usedTokens += tokens;
  }

  // --- 5. Recent history ---
  let historyTokens = 0;
  const recentEntries = memory.getRecent();
  const historyMessages: ChatMessage[] = [];

  // Add recent entries from oldest to newest
  for (const entry of recentEntries) {
    if (usedTokens + entry.tokenCount > availableBudget) break;
    historyMessages.push({
      role: entry.role === 'pc' ? 'user' : 'assistant',
      content: entry.content,
    });
    historyTokens += entry.tokenCount;
    usedTokens += entry.tokenCount;
  }

  // --- 6. Context segments (trimmable) ---
  let contextTokens = 0;
  const contextParts: string[] = [];
  for (const seg of contextSegments) {
    if (usedTokens + seg.tokenCount > availableBudget) break;
    contextParts.push(seg.content);
    contextTokens += seg.tokenCount;
    usedTokens += seg.tokenCount;
  }

  // --- Assemble system prompt ---
  const systemPromptSections = [
    ...systemParts,
    stateSection,
  ];

  if (summaryParts.length > 0) {
    systemPromptSections.push(
      `---\n[Memory Summary]\n${summaryParts.join('\n\n')}\n---`,
    );
  }

  if (contextParts.length > 0) {
    systemPromptSections.push(
      `---\n[World Knowledge]\n${contextParts.join('\n\n')}\n---`,
    );
  }

  const systemPrompt = systemPromptSections.join('\n\n');

  // AI SDK requires at least one message — add seed on first turn
  if (historyMessages.length === 0) {
    historyMessages.push({
      role: 'user',
      content: '[Game session started. Begin narration.]',
    });
  }

  return {
    systemPrompt,
    messages: historyMessages,
    tokenBreakdown: {
      system: systemTokens,
      state: stateTokens,
      summaries: summaryTokens,
      recentHistory: historyTokens,
      contextSegments: contextTokens,
      total: usedTokens,
      budget: availableBudget,
    },
  };
}

export { evaluateCondition };
