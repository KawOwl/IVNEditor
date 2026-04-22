/**
 * LLM-driven 压缩函数 —— 取代 legacy 的截断拼接
 *
 * 输入一批旧对话 entries，调 LLM 生成 3-5 句话的情节摘要。
 * 主要解决 legacy 摘要质量差 + context 稀释的问题（评审里提过的
 * in-context style drift）。
 *
 * **暂时复用主叙事 LLM**（same llmClient）。未来要让 summarizer 用独立的便宜
 * 模型，扩展点在 factory 里给 createMemory 传一个独立 llmClient 即可——
 * 接口层面已经支持。
 */

import type { MemoryEntry } from '../../types';
import type { LLMClient } from '../../llm-client';

/**
 * CompressFn —— 和 legacy 的 CompressFn 同签名，方便未来提取公共 type。
 * 但目前两个 adapter 各自持有自己的 CompressFn type alias，不共享 import
 * 路径（平行 adapter 原则）。
 */
export type CompressFn = (
  entries: MemoryEntry[],
  hints?: string,
) => Promise<string>;

const BASE_SYSTEM_PROMPT = `你是剧情摘要助手。把下面的对话浓缩成 3-5 句话的情节摘要，保留：
- 关键剧情事件
- 角色情绪 / 关系变化
- 重要的选择和后果

只输出摘要正文，不加标题、不加"以下是摘要"之类的前缀。不要换行成 bullet，写成连贯的散文段。`;

/**
 * 构造一个调 LLM 做摘要的 CompressFn。
 *
 * 压缩参数选择：
 *   - maxOutputTokens: 512 —— 3-5 句摘要完全够用；超过 512 反倒违反了
 *     "摘要"的意图
 *   - maxSteps: 1 —— 摘要不需要 tool loop，一次 LLM 调用就返回文本
 *   - tools: {} —— 不给 LLM 任何工具，强制它只输出文本
 */
export function makeLLMCompressFn(llmClient: LLMClient): CompressFn {
  return async (entries, hints) => {
    const transcript = entries
      .map((e) => {
        const who = e.role === 'receive' ? '玩家' : e.role === 'generate' ? '旁白' : '系统';
        return `${who}：${e.content}`;
      })
      .join('\n\n');

    const systemPrompt = hints
      ? `${BASE_SYSTEM_PROMPT}\n\n特别关注：${hints}`
      : BASE_SYSTEM_PROMPT;

    const result = await llmClient.generate({
      systemPrompt,
      messages: [{ role: 'user', content: transcript }],
      tools: {},
      maxSteps: 1,
      maxOutputTokens: 512,
    });

    return result.text.trim();
  };
}
