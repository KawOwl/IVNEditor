/**
 * Memorax ↔ 引擎类型映射
 *
 * Memorax 的 message 只接受 role='user'/'assistant'，没有 system 概念。
 * 跟 mem0 的映射保持一致（[mem0/mapping.mts](../mem0/mapping.mts)）：
 *   - receive（玩家输入）→ 'user'
 *   - generate（LLM 叙事）→ 'assistant'
 *   - system（pinned）→ 'assistant' 加 [PINNED] 前缀，metadata.pinned=true 由
 *     adapter 层附加
 */

import type { MemoryEntry } from '@ivn/core/types';
import type { MemoraxMessage } from '#internal/memory/memorax/client';

export function entryToMemoraxMessage(entry: MemoryEntry): MemoraxMessage {
  const timestamp = entry.timestamp;
  if (entry.role === 'receive') {
    return { role: 'user', content: entry.content, timestamp };
  }
  if (entry.role === 'system') {
    return { role: 'assistant', content: `[PINNED] ${entry.content}`, timestamp };
  }
  return { role: 'assistant', content: entry.content, timestamp };
}
