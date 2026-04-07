/**
 * MemoryManager — 分层压缩记忆系统
 *
 * - appendTurn: 追加记忆条目
 * - getRecent: 获取最近 N 条
 * - getSummaries: 获取压缩摘要
 * - compress: 触发压缩（需要外部提供 LLM 压缩函数）
 * - pin: 标记重要记忆
 * - query: 关键词搜索（初期实现，后续可接向量搜索）
 * - O(log N) 增长：摘要累积过长时合并旧摘要
 */

import type { MemoryEntry, MemoryState, MemoryConfig } from './types';

// ============================================================================
// Types
// ============================================================================

/** 外部提供的 LLM 压缩函数签名 */
export type CompressFn = (
  entries: MemoryEntry[],
  hints?: string,
) => Promise<string>;

/** 外部提供的 LLM 摘要合并函数签名 */
export type MergeSummariesFn = (
  summaries: string[],
  hints?: string,
) => Promise<string>;

// ============================================================================
// ID Generator
// ============================================================================

let counter = 0;
function generateId(): string {
  return `mem-${Date.now()}-${++counter}`;
}

// ============================================================================
// MemoryManager
// ============================================================================

export class MemoryManager {
  private state: MemoryState;
  private config: MemoryConfig;

  constructor(config: MemoryConfig, initialState?: MemoryState) {
    this.config = config;
    this.state = initialState ?? {
      entries: [],
      summaries: [],
      watermark: 0,
    };
  }

  // --- Append ---

  appendTurn(params: {
    turn: number;
    role: MemoryEntry['role'];
    content: string;
    tokenCount: number;
    tags?: string[];
  }): MemoryEntry {
    const entry: MemoryEntry = {
      id: generateId(),
      turn: params.turn,
      role: params.role,
      content: params.content,
      tokenCount: params.tokenCount,
      timestamp: Date.now(),
      tags: params.tags,
      pinned: false,
    };
    this.state.entries.push(entry);
    return entry;
  }

  // --- Read ---

  getRecent(n?: number): MemoryEntry[] {
    const window = n ?? this.config.recencyWindow;
    return this.state.entries.slice(-window);
  }

  getSummaries(): string[] {
    return [...this.state.summaries];
  }

  getInheritedSummary(): string | undefined {
    return this.state.inheritedSummary;
  }

  getAllEntries(): MemoryEntry[] {
    return [...this.state.entries];
  }

  getTotalTokenCount(): number {
    return this.state.entries.reduce((sum, e) => sum + e.tokenCount, 0);
  }

  // --- Pin ---

  pin(content: string, tags?: string[]): MemoryEntry {
    const entry: MemoryEntry = {
      id: generateId(),
      turn: -1, // pinned entries don't belong to a specific turn
      role: 'system',
      content,
      tokenCount: estimateTokens(content),
      timestamp: Date.now(),
      tags,
      pinned: true,
    };
    this.state.entries.push(entry);
    return entry;
  }

  getPinnedEntries(): MemoryEntry[] {
    return this.state.entries.filter((e) => e.pinned);
  }

  // --- Query (keyword search) ---

  query(queryText: string): MemoryEntry[] {
    const keywords = queryText.toLowerCase().split(/\s+/).filter(Boolean);
    if (keywords.length === 0) return [];

    const scored = this.state.entries
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

  // --- Compress ---

  needsCompression(): boolean {
    return this.getTotalTokenCount() > this.config.compressionThreshold;
  }

  /**
   * Compress older entries into a summary.
   * Preserves recent entries (recencyWindow) and pinned entries.
   * Requires external LLM compress function.
   */
  async compress(compressFn: CompressFn, mergeFn?: MergeSummariesFn): Promise<void> {
    const { recencyWindow, compressionHints } = this.config;
    const entries = this.state.entries;

    // Separate pinned and unpinned entries
    const pinned = entries.filter((e) => e.pinned);
    const unpinned = entries.filter((e) => !e.pinned);

    // Keep recent entries, compress older ones
    const toKeep = unpinned.slice(-recencyWindow);
    const toCompress = unpinned.slice(0, -recencyWindow);

    if (toCompress.length === 0) return;

    // Generate summary from older entries
    const summary = await compressFn(toCompress, compressionHints);
    this.state.summaries.push(summary);

    // Update watermark
    const lastCompressed = toCompress[toCompress.length - 1];
    if (lastCompressed) {
      this.state.watermark = lastCompressed.turn;
    }

    // Replace entries: pinned + recent only
    this.state.entries = [...pinned, ...toKeep];

    // Check if summaries need merging (O(log N) growth)
    if (mergeFn) {
      await this.maybeMergeSummaries(mergeFn);
    }
  }

  /**
   * Merge older summaries when cumulative size exceeds threshold.
   * Keeps total summary count at O(log N).
   */
  private async maybeMergeSummaries(mergeFn: MergeSummariesFn): Promise<void> {
    const summaryTokens = this.state.summaries.reduce(
      (sum, s) => sum + estimateTokens(s),
      0,
    );

    // If summaries exceed half the compression threshold, merge older ones
    const mergeThreshold = this.config.compressionThreshold / 2;
    if (summaryTokens <= mergeThreshold || this.state.summaries.length < 2) return;

    // Merge all but the latest summary into one
    const toMerge = this.state.summaries.slice(0, -1);
    const latest = this.state.summaries[this.state.summaries.length - 1];

    const merged = await mergeFn(toMerge, this.config.compressionHints);
    this.state.summaries = latest ? [merged, latest] : [merged];
  }

  // --- Cross-Chapter ---

  /** Compress all entries for chapter transition */
  async compressAll(compressFn: CompressFn): Promise<string> {
    const allEntries = this.state.entries.filter((e) => !e.pinned);
    if (allEntries.length === 0) {
      return this.state.summaries.join('\n\n');
    }

    const summary = await compressFn(allEntries, this.config.compressionHints);

    // Combine with existing summaries
    const allSummaries = [...this.state.summaries, summary];
    return allSummaries.join('\n\n');
  }

  setInheritedSummary(summary: string): void {
    this.state.inheritedSummary = summary;
  }

  // --- Export/Import/Restore ---

  export(): MemoryState {
    return structuredClone(this.state);
  }

  import(state: MemoryState): void {
    this.state = structuredClone(state);
  }

  /**
   * 从持久化快照恢复（DB 中存的是 entries[] 和 summaries[]）
   */
  restore(entries: MemoryEntry[], summaries: string[]): void {
    this.state.entries = structuredClone(entries);
    this.state.summaries = [...summaries];
    // 重算 watermark：取最后一条被压缩前的 turn
    const lastEntry = entries[entries.length - 1];
    this.state.watermark = lastEntry?.turn ?? 0;
  }

  /** Reset for new chapter */
  reset(): void {
    this.state = {
      entries: [],
      summaries: [],
      watermark: 0,
      inheritedSummary: this.state.inheritedSummary,
    };
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Rough token estimate: ~4 chars per token for mixed CJK/English */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export { estimateTokens };
