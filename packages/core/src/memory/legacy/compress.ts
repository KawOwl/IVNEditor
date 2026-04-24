/**
 * truncatingCompressFn —— 等价于原 game-session.ts:305-310 的 fallback
 *
 * 注意：这**不是**真摘要。每条 entry 取前 200 字符 + role 前缀，'\n' 拼接。
 * 行为保持用，不是长期方案。Phase 2 LLMSummarizer 会用真 LLM 替换这里。
 */

import type { CompressFn } from '#internal/memory/legacy/manager';

export const truncatingCompressFn: CompressFn = async (entries) => {
  return entries
    .map((e) => `[${e.role}] ${e.content.slice(0, 200)}`)
    .join('\n');
};
