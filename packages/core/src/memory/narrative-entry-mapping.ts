/**
 * NarrativeEntry → MemoryEntry 映射
 *
 * Memory Refactor v2：memory adapter 不再自持有 entries 副本，而是通过
 * NarrativeHistoryReader 读 canonical narrative_entries。这个工具把两边的
 * 类型系统桥接起来。
 *
 * 详见 .claude/plans/memory-refactor-v2.md 和 architecture-alignment.md
 *
 * ## 哪些 kind 映射
 *
 * | narrative_entries.kind | MemoryEntry | 备注 |
 * |---|---|---|
 * | `narrative`    | role='generate' | LLM 叙事原文（含 XML-lite） |
 * | `player_input` | role='receive'  | 玩家输入文本 |
 * | `signal_input` | **跳过**        | hint/choices 的上下文已由前条 narrative 自然传达 |
 * | `tool_call`    | **跳过**        | 工具副作用已在 state/scene/memory 快照里 |
 *
 * 跳过的 kind 返回 null，调用方 filter 掉。如果未来 LLM 丢失"上回合我问了 X"
 * 这类上下文，可以把 signal_input 也返回成 role='system' 的记忆。
 */

import { estimateTokens } from '../tokens';
import type { MemoryEntry } from '../types';
import type { NarrativeEntry } from '../persistence-entry';

/**
 * 把一条 NarrativeEntry 映射成 MemoryEntry。
 * 返回 null = 对 LLM recency 上下文无意义，跳过。
 */
export function narrativeToMemoryEntry(e: NarrativeEntry): MemoryEntry | null {
  switch (e.kind) {
    case 'narrative':
      return {
        id: e.id,
        // Memory Refactor v2：不从 narrative_entries 推导 turn 号；
        // recency 只看 orderIdx 序即可。turn 字段保留 0 占位。
        turn: 0,
        role: 'generate',
        content: e.content,
        tokenCount: estimateTokens(e.content),
        timestamp: e.createdAt.getTime(),
        pinned: false,
      };

    case 'player_input':
      return {
        id: e.id,
        turn: 0,
        role: 'receive',
        content: e.content,
        tokenCount: estimateTokens(e.content),
        timestamp: e.createdAt.getTime(),
        pinned: false,
      };

    case 'signal_input':
      // 跳过：上下文已在前条 narrative 的自然语言里
      return null;

    case 'tool_call':
      // 跳过：副作用已在 state/scene 快照里
      return null;
  }
}

/**
 * 批量映射 + 过滤掉跳过的 kind。保持原 orderIdx 顺序。
 */
export function narrativeEntriesToMemoryEntries(
  entries: NarrativeEntry[],
): MemoryEntry[] {
  const result: MemoryEntry[] = [];
  for (const e of entries) {
    const mapped = narrativeToMemoryEntry(e);
    if (mapped) result.push(mapped);
  }
  return result;
}
