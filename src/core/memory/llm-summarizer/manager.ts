/**
 * LLMSummarizerMemory —— Memory Refactor v2（2026-04-23）：reader-based 实现
 *
 * 和 LegacyMemory 结构对齐（各自独立，无继承），唯一功能差别：
 *   - compressFn 走真 LLM（makeLLMCompressFn 产物），而不是截断拼接
 *   - snapshot.kind = 'llm-summarizer-v2'（和 legacy 的 'legacy-v2' 隔离）
 *
 * 详见 .claude/plans/memory-refactor-v2.md
 */

import { estimateTokens } from '../../tokens';
import type { MemoryEntry, MemoryConfig } from '../../types';
import type { ChatMessage } from '../../context-assembler';
import type { LLMClient } from '../../llm-client';
import type {
  Memory,
  MemoryRetrieval,
  MemorySnapshot,
  RecentMessagesResult,
} from '../types';
import type { NarrativeHistoryReader } from '../narrative-reader';
import { narrativeEntriesToMemoryEntries } from '../narrative-entry-mapping';
import { makeLLMCompressFn, type CompressFn } from './compress';

// ============================================================================
// Snapshot kind
// ============================================================================

const SNAPSHOT_KIND_V2 = 'llm-summarizer-v2';
const SNAPSHOT_KIND_V1 = 'llm-summarizer-v1';

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
    llmClient: LLMClient,
    private readonly reader?: NarrativeHistoryReader,
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
    // v2 no-op：对话原件由 persistence 层写 narrative_entries，adapter 不再双写
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
    const parts: string[] = [];
    for (const s of this.state.summaries) parts.push(s);
    for (const p of this.state.pinned) parts.push(`[重要] ${p.content}`);

    const recent = await this.readRecentMemoryEntries();
    return {
      summary: parts.join('\n\n'),
      entries: this.keywordMatch(query, recent),
    };
  }

  async getRecentAsMessages(
    opts: { budget: number },
  ): Promise<RecentMessagesResult> {
    const window = this.config.recencyWindow;
    if (!this.reader) {
      return { messages: [], tokensUsed: 0 };
    }
    const raw = await this.reader.readRecent({
      limit: window,
      kinds: ['narrative', 'player_input'],
    });
    const entries = narrativeEntriesToMemoryEntries(raw);

    const messages: ChatMessage[] = [];
    let used = 0;
    for (const e of entries) {
      if (used + e.tokenCount > opts.budget) break;
      messages.push({
        role: e.role === 'receive' ? 'user' : 'assistant',
        content: e.content,
      });
      used += e.tokenCount;
    }
    return { messages, tokensUsed: used };
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  async maybeCompact(): Promise<void> {
    if (!this.reader) return;

    const pending = await this.reader.readRange({
      fromOrderIdx: this.state.compressedUpTo + 1,
    });
    const memoryEntries = narrativeEntriesToMemoryEntries(pending);
    const totalTokens = memoryEntries.reduce((s, e) => s + e.tokenCount, 0);
    if (totalTokens <= this.config.compressionThreshold) return;

    const toCompress = memoryEntries.slice(0, -this.config.recencyWindow);
    if (toCompress.length === 0) return;

    const summary = await this.compressFn(toCompress, this.config.compressionHints);
    this.state.summaries.push(summary);

    const lastCompressedId = toCompress[toCompress.length - 1]?.id;
    if (lastCompressedId) {
      const orig = pending.find((e) => e.id === lastCompressedId);
      if (orig) this.state.compressedUpTo = orig.orderIdx;
    }
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
    if (snap.kind === SNAPSHOT_KIND_V1) {
      // 老格式兼容：从 entries.pinned=true 提取
      const oldEntries = (snap.entries ?? []) as MemoryEntry[];
      this.state = {
        summaries: [...((snap.summaries ?? []) as string[])],
        pinned: structuredClone(oldEntries.filter((e) => e.pinned)),
        compressedUpTo: -1,
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
    if (!this.reader) return [];
    const raw = await this.reader.readRecent({
      limit: Math.max(this.config.recencyWindow * 4, 100),
      kinds: ['narrative', 'player_input'],
    });
    return narrativeEntriesToMemoryEntries(raw);
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
