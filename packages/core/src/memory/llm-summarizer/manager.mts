/**
 * LLMSummarizerMemory —— Memory Refactor v2（2026-04-23）：reader-based 实现
 *
 * 和 LegacyMemory 结构对齐（各自独立，无继承），唯一功能差别：
 *   - compressFn 走真 LLM（makeLLMCompressFn 产物），而不是截断拼接
 *   - snapshot.kind = 'llm-summarizer-v2'（和 legacy 的 'legacy-v2' 隔离）
 *
 * 详见 .claude/plans/memory-refactor-v2.md
 */

import { estimateTokens } from '@ivn/core/tokens';
import type { MemoryEntry, MemoryConfig } from '@ivn/core/types';
import type { LLMClient } from '@ivn/core/llm-client';
import {
  buildMessagesFromCoreEventHistory,
  capMessagesByBudgetFromTail,
  projectCoreEventHistoryToMemoryEntries,
} from '#internal/game-session/core-event-history';
import type { CoreEventHistoryReader } from '#internal/game-session/core-event-history';
import type {
  Memory,
  MemoryDeletionFilter,
  MemoryRetrieval,
  MemorySnapshot,
  RecentMessagesResult,
} from '#internal/memory/types';
import { makeLLMCompressFn, type CompressFn } from '#internal/memory/llm-summarizer/compress';

// ============================================================================
// Snapshot kind
// ============================================================================

const SNAPSHOT_KIND_V2 = 'llm-summarizer-v2';

// ============================================================================
// Internal state (v2)
// ============================================================================

interface LLMSummarizerState {
  summaries: string[];
  pinned: MemoryEntry[];
  compressedUpTo: number;
}

// ============================================================================
// ID generator
// ============================================================================

let counter = 0;
function generateId(): string {
  return `mem-llm-${Date.now()}-${++counter}`;
}

// ============================================================================
// LLMSummarizerMemory
// ============================================================================

export class LLMSummarizerMemory implements Memory {
  readonly kind = 'llm-summarizer';
  private state: LLMSummarizerState = { summaries: [], pinned: [], compressedUpTo: -1 };
  private readonly compressFn: CompressFn;

  constructor(
    private readonly config: MemoryConfig,
    llmClient: Pick<LLMClient, 'generate'>,
    private readonly coreEventReader?: CoreEventHistoryReader,
    /** ANN.1：删除过滤器。详见 LegacyMemory 同名构造参数。*/
    private readonly deletionFilter?: MemoryDeletionFilter,
  ) {
    this.compressFn = makeLLMCompressFn(llmClient);
  }

  // ─── Write ─────────────────────────────────────────────────────────

  async appendTurn(params: {
    turn: number;
    role: MemoryEntry['role'];
    content: string;
    tokenCount: number;
    tags?: string[];
  }): Promise<MemoryEntry> {
    // no-op：对话原件由 CoreEvent 日志持久化，adapter 不再双写。
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
    const entry: MemoryEntry = {
      id: generateId(),
      turn: -1,
      role: 'system',
      content,
      tokenCount: estimateTokens(content),
      timestamp: Date.now(),
      tags,
      pinned: true,
    };
    this.state.pinned.push(entry);
    return entry;
  }

  // ─── Read ──────────────────────────────────────────────────────────

  async retrieve(query: string): Promise<MemoryRetrieval> {
    const deletedIds = await this.loadDeletedIds();

    const filteredPinned = deletedIds.size > 0
      ? this.state.pinned.filter((e) => !deletedIds.has(e.id))
      : this.state.pinned;

    const parts = [
      ...this.state.summaries,
      ...filteredPinned.map((entry) => `[重要] ${entry.content}`),
    ];

    const recent = await this.readRecentMemoryEntries();
    const matched = this.keywordMatch(query, recent);
    const filteredEntries = deletedIds.size > 0
      ? matched.filter((e) => !deletedIds.has(e.id))
      : matched;

    return {
      summary: parts.join('\n\n'),
      entries: filteredEntries,
    };
  }

  /** ANN.1：失败静默返回空集合，详见 LegacyMemory 同名方法。*/
  private async loadDeletedIds(): Promise<ReadonlySet<string>> {
    if (!this.deletionFilter) return new Set();
    try {
      return await this.deletionFilter.listDeleted();
    } catch (err) {
      console.warn('[LLMSummarizerMemory] deletionFilter.listDeleted failed:', err);
      return new Set();
    }
  }

  async getRecentAsMessages(
    opts: { budget: number },
  ): Promise<RecentMessagesResult> {
    const window = this.config.recencyWindow;
    if (!this.coreEventReader) {
      return { messages: [], tokensUsed: 0 };
    }
    const raw = await this.coreEventReader.readRecent({
      limit: Math.max(window * 8, 200),
    });
    const projected = buildMessagesFromCoreEventHistory(raw);
    return capMessagesByBudgetFromTail(projected, opts.budget);
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  async maybeCompact(): Promise<void> {
    if (!this.coreEventReader) return;

    const pending = await this.coreEventReader.readRange({
      fromSequence: this.state.compressedUpTo + 1,
    });
    const memoryEntries = projectCoreEventHistoryToMemoryEntries(pending);
    const totalTokens = memoryEntries.reduce((s, e) => s + e.tokenCount, 0);
    if (totalTokens <= this.config.compressionThreshold) return;

    const toCompress = memoryEntries.slice(0, -this.config.recencyWindow);
    if (toCompress.length === 0) return;

    const summary = await this.compressFn(toCompress, this.config.compressionHints);
    this.state.summaries.push(summary);

    const lastCompressed = toCompress[toCompress.length - 1];
    if (lastCompressed) this.state.compressedUpTo = lastCompressed.sequence;
  }

  async snapshot(): Promise<MemorySnapshot> {
    return {
      kind: SNAPSHOT_KIND_V2,
      summaries: [...this.state.summaries],
      pinned: structuredClone(this.state.pinned),
      compressedUpTo: this.state.compressedUpTo,
    };
  }

  async restore(snap: MemorySnapshot): Promise<void> {
    if (snap.kind === SNAPSHOT_KIND_V2) {
      this.state = {
        summaries: [...((snap.summaries ?? []) as string[])],
        pinned: structuredClone((snap.pinned ?? []) as MemoryEntry[]),
        compressedUpTo: (snap.compressedUpTo as number | undefined) ?? -1,
      };
      return;
    }
    throw new Error(
      `LLMSummarizerMemory cannot restore from kind: ${String(snap.kind)}. ` +
        `提示：adapter 间 snapshot 不可互换；切换 provider 需新建 playthrough。`,
    );
  }

  async reset(): Promise<void> {
    this.state = { summaries: [], pinned: [], compressedUpTo: -1 };
  }

  // ─── Internal helpers ──────────────────────────────────────────────

  private async readRecentMemoryEntries(): Promise<MemoryEntry[]> {
    if (!this.coreEventReader) return [];
    const raw = await this.coreEventReader.readRecent({
      limit: Math.max(this.config.recencyWindow * 8, 200),
    });
    return projectCoreEventHistoryToMemoryEntries(raw);
  }

  private keywordMatch(query: string, entries: MemoryEntry[]): MemoryEntry[] {
    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (keywords.length === 0) return [];

    const scored = entries
      .map((entry) => {
        const text = entry.content.toLowerCase();
        const score = keywords.reduce(
          (acc, kw) => acc + (text.includes(kw) ? 1 : 0),
          0,
        );
        return { entry, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.map((item) => item.entry);
  }
}
