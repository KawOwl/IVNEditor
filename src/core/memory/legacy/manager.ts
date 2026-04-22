/**
 * LegacyMemory —— 原 MemoryManager 在新 Memory 接口下的等价实现
 *
 * 行为和 src/core/memory.ts 的 MemoryManager **字节级等价**，除一处主动修复：
 *   - pinned entries 现在通过 retrieve() 进入 `_engine_memory` section
 *     （原 context-assembler.ts:170-184 漏读了 getPinnedEntries，
 *      见 2026-04-19 审计报告）
 *
 * 其他特性保持原样：
 *   - 截断拼接式"压缩"（由 truncatingCompressFn 提供）
 *   - 两阶段压缩的第二阶段 maybeMergeSummaries 从未被调用（和原来一样）
 *   - query 是关键词匹配（空格分词 + 词频打分）
 *   - inheritedSummary 彻底移除（章节不再是 memory 生命周期事件）
 */

import { estimateTokens } from '../../tokens';
import type { MemoryEntry, MemoryConfig } from '../../types';
import type { ChatMessage } from '../../context-assembler';
import type {
  Memory,
  MemoryRetrieval,
  MemorySnapshot,
  RecentMessagesResult,
} from '../types';

// ============================================================================
// Compress function contract
// ============================================================================

/**
 * 外部提供的压缩函数签名
 *
 * - Legacy：truncatingCompressFn（截断拼接）
 * - LLMSummarizer（Phase 2）：调真 LLM 做摘要
 */
export type CompressFn = (
  entries: MemoryEntry[],
  hints?: string,
) => Promise<string>;

// ============================================================================
// ID generator
// ============================================================================

let counter = 0;
function generateId(): string {
  return `mem-${Date.now()}-${++counter}`;
}

// ============================================================================
// Internal state
// ============================================================================

/**
 * Legacy adapter 的内部状态
 *
 * 注意：不含 inheritedSummary —— 章节继承从 Memory 接口剥离
 * （executeChapterTransition 本就是死代码，没有 playthrough 会受影响）
 */
interface LegacyState {
  entries: MemoryEntry[];
  summaries: string[];
  watermark: number;
}

// ============================================================================
// LegacyMemory
// ============================================================================

export class LegacyMemory implements Memory {
  readonly kind = 'legacy';
  private state: LegacyState = { entries: [], summaries: [], watermark: 0 };

  constructor(
    private readonly config: MemoryConfig,
    private readonly compressFn: CompressFn,
  ) {}

  // ─── Write ─────────────────────────────────────────────────────────

  async appendTurn(params: {
    turn: number;
    role: MemoryEntry['role'];
    content: string;
    tokenCount: number;
    tags?: string[];
  }): Promise<MemoryEntry> {
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

  async pin(content: string, tags?: string[]): Promise<MemoryEntry> {
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

  // ─── Read ──────────────────────────────────────────────────────────

  /**
   * 等价于：原 getSummaries() + pinned entries（作为 summary 前缀）+ query() 给 entries
   *
   * ⚠ Pre-existing bug 修复：原 context-assembler.ts:170-184 只读
   * getSummaries() + getInheritedSummary()，漏掉 getPinnedEntries()。
   * 现在把 pinned 一并拼进 summary，保证 LLM 调 pin_memory 后的条目
   * 真的出现在 `_engine_memory` section 里。
   *
   * query 参数对 legacy 只影响 entries 字段（关键词匹配）；summary 不依赖 query。
   * 空 query 合法 —— 关键词匹配对空查询返回空数组。
   */
  async retrieve(query: string): Promise<MemoryRetrieval> {
    const pinned = this.state.entries.filter((e) => e.pinned);
    const parts: string[] = [];
    for (const s of this.state.summaries) parts.push(s);
    for (const p of pinned) parts.push(`[重要] ${p.content}`);

    return {
      summary: parts.join('\n\n'),
      entries: this.keywordMatch(query),
    };
  }

  /**
   * 等价于：原 context-assembler.ts:258-279 的 for 循环 + role 翻译 + budget break
   *
   * receive → user、generate/system → assistant。budget 超限时逐条 break。
   */
  async getRecentAsMessages(
    opts: { budget: number },
  ): Promise<RecentMessagesResult> {
    const window = this.config.recencyWindow;
    const recent = this.state.entries.slice(-window);

    const messages: ChatMessage[] = [];
    let used = 0;
    for (const e of recent) {
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
    if (this.getTotalTokenCount() <= this.config.compressionThreshold) return;
    await this.compressOnce();
  }

  /**
   * 等价于：原 MemoryManager.compress 的第一阶段（第二阶段 maybeMergeSummaries
   * 在旧代码里从未被调用，这里同样不实现）
   */
  private async compressOnce(): Promise<void> {
    const { recencyWindow, compressionHints } = this.config;
    const pinned = this.state.entries.filter((e) => e.pinned);
    const unpinned = this.state.entries.filter((e) => !e.pinned);
    const toKeep = unpinned.slice(-recencyWindow);
    const toCompress = unpinned.slice(0, -recencyWindow);
    if (toCompress.length === 0) return;

    const summary = await this.compressFn(toCompress, compressionHints);
    this.state.summaries.push(summary);

    const last = toCompress[toCompress.length - 1];
    if (last) this.state.watermark = last.turn;

    this.state.entries = [...pinned, ...toKeep];
  }

  async snapshot(): Promise<MemorySnapshot> {
    return {
      kind: 'legacy-v1',
      entries: structuredClone(this.state.entries),
      summaries: [...this.state.summaries],
      watermark: this.state.watermark,
    };
  }

  async restore(snap: MemorySnapshot): Promise<void> {
    if (snap.kind !== 'legacy-v1') {
      throw new Error(
        `LegacyMemory cannot restore from kind: ${String(snap.kind)}`,
      );
    }
    this.state = {
      entries: structuredClone((snap.entries ?? []) as MemoryEntry[]),
      summaries: [...((snap.summaries ?? []) as string[])],
      watermark: (snap.watermark ?? 0) as number,
    };
  }

  async reset(): Promise<void> {
    this.state = { entries: [], summaries: [], watermark: 0 };
  }

  // ─── Internal helpers ──────────────────────────────────────────────

  private getTotalTokenCount(): number {
    return this.state.entries.reduce((s, e) => s + e.tokenCount, 0);
  }

  /**
   * 等价于：原 MemoryManager.query
   *
   * 空格分词 + 词频打分 + 按分数降序。空 query 返回空数组。
   * 不截断（调用方自己切片）。
   */
  private keywordMatch(query: string): MemoryEntry[] {
    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
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
}
