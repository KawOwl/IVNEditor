/**
 * Mem0 ↔ 引擎的类型映射
 *
 * 两个职责：
 *   1. MemoryEntry.role ('generate' | 'receive' | 'system') →
 *      mem0 Message.role ('user' | 'assistant')
 *   2. Scope → mem0 EntityOptions.userId
 */

import type { MemoryEntry } from '@ivn/core/types';

/**
 * 把引擎 entry 转成 mem0 能接受的 message 格式。
 *
 * mem0 只支持 role='user'/'assistant'。映射规则：
 *   - receive（玩家输入）→ 'user'
 *   - generate（LLM 叙事）→ 'assistant'
 *   - system（pinned 等）→ 'assistant' + 内容加 [PINNED] 前缀让 mem0 model
 *     知道这是重要信息（mem0 自身没有 pin 概念，靠内容语义和 metadata.pinned）
 */
export function entryToMem0Message(entry: MemoryEntry): {
  role: 'user' | 'assistant';
  content: string;
} {
  if (entry.role === 'receive') {
    return { role: 'user', content: entry.content };
  }
  if (entry.role === 'system') {
    return { role: 'assistant', content: `[PINNED] ${entry.content}` };
  }
  // 'generate'（也作 fallback）
  return { role: 'assistant', content: entry.content };
}

/**
 * playthroughId 作为 mem0 user_id —— **严格隔离**。
 *
 * 为什么不用用户账号 id：一个玩家可能玩多个 playthrough（同一剧本不同存档，
 * 或完全不同剧本）。不同 playthrough 的记忆必须完全隔离，否则会串。
 * mem0 user_id 就是"这份记忆的所有者"，和 playthrough 是 1:1 映射。
 */
export function playthroughToMem0UserId(playthroughId: string): string {
  return `playthrough-${playthroughId}`;
}
