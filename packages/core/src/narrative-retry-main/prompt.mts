/**
 * Narrative Retry-Main — Prompt / Messages 构造
 *
 * 复用 main path 的 system prompt（context-assembler 产出），追加：
 *   - main path 这一轮的 raw 输出（作为 assistant message）
 *   - 引擎 nudge user message：明确告诉 LLM "你刚才漏写了正文，重新输出本轮"
 *
 * 关键设计：让 LLM 看见自己刚才的 raw（包括 scratch / 工具文本）——
 * 否则它在新一次调用里很可能再次只写 scratch / 漏写正文（与上轮同样的失败
 * 模式）。trace 93f1f0a9 这种 case 就是 LLM 写完 scratch 觉得"想清楚了，
 * 等玩家输入吧"就 stop 了；让它看到自己 raw + 显式 nudge "scratch 不算正文，
 * 重新写给玩家看的 narration / dialogue"，比静默重跑更可能修正。
 */

import type { ModelMessage } from 'ai';

/**
 * 引擎 nudge user message 的固定文案。字节稳定，便于 prompt cache 在 system
 * 不变时复用前缀。
 */
const RETRY_MAIN_NUDGE =
  `[引擎提示] 你刚才本轮的输出里**没有**给玩家可读的 \`<narration>\` 或 \`<dialogue>\`——\n` +
  `玩家本轮看不到任何正文。这通常因为你只写了 \`<scratch>\` 内心戏、或者只调了\n` +
  `工具就停了。\n` +
  `\n` +
  `现在请**重新输出本轮的正文**：\n` +
  `\n` +
  `- 必须包含至少一条 \`<narration>\` 或 \`<dialogue>\`，IVN XML 协议格式（标签必须闭合）\n` +
  `- 不要再写 \`<scratch>\`——你已经想清楚了，直接给玩家看结果\n` +
  `- 不要调用任何工具——本轮的 \`signal_input_needed\` 已由引擎处理\n` +
  `- 不要补全前几轮没写完的剧情——只接着你刚才的思路给玩家看一段他能感知的内容\n` +
  `\n` +
  `1-3 个 sentence 通常够。只输出叙事正文。`;

/**
 * 构造 retry-main 的完整 messages 序列。
 *
 * 输入：main path 进入时的 messages（不含本轮输出）+ main path 这一轮的
 * 全部 raw text。
 *
 * 输出：在原 messages 末尾追加：
 *   1. assistant(rawText)：让 LLM 看到刚才输出了什么
 *   2. user(RETRY_MAIN_NUDGE)：明确告诉它"重新输出本轮正文"
 *
 * 不修改原 messages（caller 传进来的数组保持引用稳定，方便 prompt cache）。
 */
export function buildRetryMainMessages(
  mainPathMessages: ReadonlyArray<ModelMessage>,
  rawText: string,
): ModelMessage[] {
  const out: ModelMessage[] = [...mainPathMessages];
  // raw 可能为空白（理论上不会走到 retry-main，但兜底加一条）
  if (rawText.trim().length > 0) {
    out.push({ role: 'assistant', content: rawText });
  }
  out.push({ role: 'user', content: RETRY_MAIN_NUDGE });
  return out;
}

/**
 * 暴露 nudge 文案常量给测试 / debug——`buildRetryMainMessages` 内部用此构造
 * 最后一条 user message 的 content。
 */
export const RETRY_MAIN_NUDGE_CONTENT = RETRY_MAIN_NUDGE;
