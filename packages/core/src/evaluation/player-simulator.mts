/**
 * PlayerSimulator —— LLM-driven 模拟玩家
 *
 * 给定 persona（goal + 可选 style + LLM config），每轮根据 GM 的旁白 / 提示 /
 * 可选回应，生成一段玩家这轮要说/选的话。
 *
 * 设计要点：
 *   - 每个 simulator 实例只属于一次评测 run，内部维护自己的 chat history（不调
 *     memory module，不持久化）。让玩家看 own past 输出，靠 chat 历史滚累积上下文。
 *   - 不走 LLMClient.generate —— 不需要 agentic loop / tool support / signal_input
 *     follow-up 这些 GM 端的复杂度。直接用 AI SDK 的 generateText，一来一回。
 *   - thinkingEnabled / reasoningEffort 由调用方在 llmConfig 里关掉（省钱 +
 *     减少 reasoning 泄漏到 final output 的风险）。createNoThinkingLLMConfig 一行就行。
 *   - prompt 里 6 条规则压制"作为玩家"、"我的选择是"等元话语；输出后 sanitize
 *     砍前后引号 / markdown / bullet 头，兜底常见格式滑边。
 */

import { generateText, type ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LLMConfig } from '#internal/llm-client';

export interface PlayerPersona {
  /** 玩家想达成的目标。注入 system prompt。例："拿到银钥匙打开禁门"。*/
  readonly goal: string;
  /** 可选说话风格，注入 system prompt。例："话不多，直奔目标"。*/
  readonly style?: string;
  /**
   * 玩家用的 LLM —— 可以跟 GM 不同。**调用方负责** thinkingEnabled=false /
   * reasoningEffort=null 等省钱开关；用 createNoThinkingLLMConfig 一行搞定。
   */
  readonly llmConfig: LLMConfig;
}

export interface SimulatorTurnContext {
  readonly turn: number;
  /** 本轮 GM 输出的合并叙事文本（可能是多段 narration 拼起来）。*/
  readonly narration: string;
  /** signal_input_needed 的 hint，无则 null。*/
  readonly hint: string | null;
  /** signal_input_needed 的 choices，可空（无 signal 或自由输入轮）。*/
  readonly choices: ReadonlyArray<string>;
}

export interface PlayerSimulator {
  decide(turn: SimulatorTurnContext): Promise<string>;
}

export function createLLMPlayerSimulator(persona: PlayerPersona): PlayerSimulator {
  const model = createSimulatorModel(persona.llmConfig);
  const systemPrompt = buildSimulatorSystemPrompt(persona);
  const history: ModelMessage[] = [];

  return {
    async decide(turn: SimulatorTurnContext): Promise<string> {
      history.push({ role: 'user', content: buildTurnContextMessage(turn) });

      const result = await generateText({
        model,
        system: systemPrompt,
        messages: history,
        maxOutputTokens: 200,
      });

      const cleaned = sanitizeSimulatorOutput(result.text);
      history.push({ role: 'assistant', content: cleaned });
      return cleaned;
    },
  };
}

function createSimulatorModel(config: LLMConfig) {
  if (config.provider === 'anthropic') {
    const provider = createAnthropic({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
      headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
    });
    return provider(config.model);
  }
  const provider = createOpenAICompatible({
    name: config.name ?? 'player-simulator',
    baseURL: config.baseURL,
    apiKey: config.apiKey,
  });
  return provider.chatModel(config.model);
}

// ============================================================================
// Prompt builders + output sanitizer (exported for unit testing)
// ============================================================================

export function buildSimulatorSystemPrompt(persona: PlayerPersona): string {
  const lines = [
    '你是这次互动小说的**玩家**，不是 narrator、不是 GM、不是评论者。',
    '',
    '【你的目标】',
    persona.goal,
  ];
  if (persona.style) {
    lines.push('', '【你的说话风格】', persona.style);
  }
  lines.push(
    '',
    '【每轮做什么】',
    '读 GM 给你的旁白、提示和（可能的）可选回应，然后写出你这一轮要说/做的事。',
    '',
    '【输出规则】',
    '1. 如果【可选回应】里有合适的一项 → 逐字复述那一项原文（不要改字、不要加标点、不要带编号）',
    '2. 如果都不合心意 / 没有可选回应 → 用一句话自由输入（不超过 30 字）',
    '3. 直接输出，不要前缀（不要"我会"、"我的选择是"、"作为玩家"、"好的"）',
    '4. 不要解释你为什么这么选，不要加任何 meta 注释',
    '5. 不要加引号、不要 markdown',
    '6. 不要说"作为 AI"或跳出角色',
    '',
    '【输出长度】',
    '单行，不超过 30 字。',
  );
  return lines.join('\n');
}

export function buildTurnContextMessage(turn: SimulatorTurnContext): string {
  const choicesBlock = turn.choices.length > 0
    ? turn.choices.map((c, i) => `${i + 1}. ${c}`).join('\n')
    : '（无，请自由输入）';
  return [
    '【GM 旁白】',
    turn.narration,
    '',
    '【GM 提示】',
    turn.hint ?? '（无）',
    '',
    '【可选回应】',
    choicesBlock,
  ].join('\n');
}

/**
 * 兜底常见 LLM 格式滑边：前后引号（中英）、bold markdown、leading bullet。
 * 不做更激进的清理（如剥"我会"等元前缀）—— 那些靠 prompt 压制；如果还出现就是
 * prompt 该改，不是 sanitizer 该兜底。
 */
export function sanitizeSimulatorOutput(text: string): string {
  return text
    .trim()
    .replace(/^["「『](.*)["」』]$/s, '$1')
    .replace(/^\*\*(.*)\*\*$/s, '$1')
    .replace(/^[-*]\s*/, '')
    .trim();
}
