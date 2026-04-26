/**
 * NoopMemory —— "完全不插入任何记忆" 的评测基线
 *
 * 用法：A/B 评测时作为零基线，跟 mem0 / llm-summarizer 对比"加上记忆有多大
 * 收益"。比"legacy 配 compressionThreshold=MAX_INT 不调 pin_memory"更显式。
 *
 * 行为：
 *   - retrieve / pin / appendTurn / maybeCompact 全部 no-op（returning 占位）
 *   - retrieve 永远返回空 summary → context-assembler 不生成 _engine_memory section
 *   - getRecentAsMessages 仍然走 CoreEventHistoryReader 投影最近 recencyWindow 条
 *     —— "记忆"特指 `_engine_memory`，最近 chat history 走 messages 通道是 LLM
 *     协议要求（DeepSeek thinking + tool 强依赖 assistant/tool 配对的多轮历史，
 *     没有就拒绝请求）。
 */

import type { MemoryEntry, MemoryConfig } from '@ivn/core/types';
import {
  buildMessagesFromCoreEventHistory,
  capMessagesByBudgetFromTail,
} from '#internal/game-session/core-event-history';
import type { CoreEventHistoryReader } from '#internal/game-session/core-event-history';
import type {
  Memory,
  MemoryRetrieval,
  MemorySnapshot,
  RecentMessagesResult,
} from '#internal/memory/types';

const SNAPSHOT_KIND = 'noop-v1';

let counter = 0;
function generateId(): string {
  return `mem-noop-${Date.now()}-${++counter}`;
}

export class NoopMemory implements Memory {
  readonly kind = 'noop';

  constructor(
    private readonly config: MemoryConfig,
    private readonly coreEventReader?: CoreEventHistoryReader,
  ) {}

  async appendTurn(params: {
    turn: number;
    role: MemoryEntry['role'];
    content: string;
    tokenCount: number;
    tags?: string[];
  }): Promise<MemoryEntry> {
    return {
      id: generateId(),
      turn: params.turn,
      role: params.role,
      content: params.content,
      tokenCount: params.tokenCount,
      timestamp: Date.now(),
      tags: params.tags,
      pinned: false,
    };
  }

  async pin(content: string, tags?: string[]): Promise<MemoryEntry> {
    return {
      id: generateId(),
      turn: -1,
      role: 'system',
      content,
      tokenCount: 0,
      timestamp: Date.now(),
      tags,
      pinned: true,
    };
  }

  async retrieve(): Promise<MemoryRetrieval> {
    return { summary: '', entries: [] };
  }

  async getRecentAsMessages(opts: { budget: number }): Promise<RecentMessagesResult> {
    if (!this.coreEventReader) return { messages: [], tokensUsed: 0 };
    const items = await this.coreEventReader.readRecent({ limit: this.config.recencyWindow });
    const projected = buildMessagesFromCoreEventHistory(items);
    return capMessagesByBudgetFromTail(projected, opts.budget);
  }

  async maybeCompact(): Promise<void> {
    /* no-op */
  }

  async snapshot(): Promise<MemorySnapshot> {
    return { kind: SNAPSHOT_KIND };
  }

  async restore(snap: MemorySnapshot): Promise<void> {
    if (snap.kind !== SNAPSHOT_KIND) {
      throw new Error(`NoopMemory cannot restore from kind: ${String(snap.kind)}`);
    }
  }

  async reset(): Promise<void> {
    /* no-op */
  }
}
