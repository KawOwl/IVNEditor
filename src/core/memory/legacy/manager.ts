/**
 * LegacyMemory —— Memory Refactor v2（2026-04-23）：reader-based 实现
 *
 * 见 .claude/plans/memory-refactor-v2.md 和 architecture-alignment.md
 *
 * 和旧版本（2026-04-11 的 refactor v1）的区别：
 *   - 不再持有 `state.entries` —— 对话历史通过 NarrativeHistoryReader 从 canonical
 *     narrative_entries 读
 *   - 内部状态瘦身为：summaries（派生摘要）+ pinned（pin_memory 显式记）+
 *     compressedUpTo（压缩游标）
 *   - snapshot 格式 v1 → v2：去掉 entries 字段
 *   - restore 兼容 v1（从 entries 里提取 pinned=true + 保留 summaries）
 *
 * 保留：
 *   - compressFn 截断拼接契约不动
 *   - pinned entries 进入 retrieve().summary 的 `[重要]` 前缀列表
 *   - 空 query 合法，返回空 entries（keyword match 在 reader 拿到的条目上跑）
 *   - maybeCompact 由 token 阈值触发
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
import type { NarrativeHistoryReader } from '../narrative-reader';
import { narrativeEntriesToMemoryEntries } from '../narrative-entry-mapping';

// ============================================================================
// Compress function contract
// ============================================================================

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
// Internal state (v2)
// ============================================================================

/**
 * Legacy adapter 内部状态（v2 —— Memory Refactor v2）
 *
 * 和 v1 的区别：
 *   - 删除 `entries`：对话原件走 reader，不再双写
 *   - 新增 `pinned`：pin_memory tool 显式记的条目（不在 narrative_entries 里）
 *   - 新增 `compressedUpTo`：记录最后一次压缩覆盖到哪条 orderIdx（-1 = 从未压缩）
 */
interface LegacyState {
  summaries: string[];
  pinned: MemoryEntry[];
  compressedUpTo: number;
}

// ============================================================================
// LegacyMemory
// ============================================================================

export class LegacyMemory implements Memory {
  readonly kind = 'legacy';
  private state: LegacyState = { summaries: [], pinned: [], compressedUpTo: -1 };

  constructor(
    private readonly config: MemoryConfig,
    private readonly compressFn: CompressFn,
    /**
     * Memory Refactor v2 注入：从 narrative_entries 读历史。
     * undefined 时（单测场景）retrieve / getRecentAsMessages 保守返回空；
     * maybeCompact 变成 no-op。生产路径 session-manager 必传。
     */
    private readonly reader?: NarrativeHistoryReader,
  ) {}

  // ─── Write ─────────────────────────────────────────────────────────

  /**
   * Memory Refactor v2：appendTurn 不再写 state.entries。
   * 上游（game-session）仍然会调 —— 保留签名兼容，作为"轮次推进"通知；
   * 真正的对话原件由 persistence 层在写 narrative_entries 时已经记下。
   *
   * 返回值保留 MemoryEntry（id/role/content 等），调用方主要看日志/调试用。
   */
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

  // ─── Read ─────────────────────────────────────────────────────────

  /**
   * summary = summaries + pinned（同 v1 格式）
   * entries = 对 reader 返回的近期条目做 keyword match（同 v1 语义）
   */
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

  /**
   * 从 reader 读最近 recencyWindow 条 → 映射成 MemoryEntry → role 翻译 + budget cap。
   */
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

  // ─── Lifecycle ────────────────────────────────────────────────────

  /**
   * 从 `compressedUpTo+1` 往后读，如果总 token 超阈值，把 [最早, N-recencyWindow] 压成
   * 一条新 summary，推进 compressedUpTo 到被压缩段的最后 orderIdx。
   *
   * reader 不存在时（单测）no-op。
   */
  async maybeCompact(): Promise<void> {
    if (!this.reader) return;

    // 拉自上次压缩以来（+ 所有更早的 recent 兜底）的完整区间
    const pending = await this.reader.readRange({
      fromOrderIdx: this.state.compressedUpTo + 1,
    });
    const memoryEntries = narrativeEntriesToMemoryEntries(pending);
    const totalTokens = memoryEntries.reduce((s, e) => s + e.tokenCount, 0);
    if (totalTokens <= this.config.compressionThreshold) return;

    // 保留最新 recencyWindow 条不压缩；更早的做 compressFn
    const toKeep = memoryEntries.slice(-this.config.recencyWindow);
    const toCompress = memoryEntries.slice(0, -this.config.recencyWindow);
    if (toCompress.length === 0) return;

    const summary = await this.compressFn(toCompress, this.config.compressionHints);
    this.state.summaries.push(summary);

    // 推进 compressedUpTo 到最后一条被压缩 entry 对应的 orderIdx
    // 需要反查 pending 里对应的 NarrativeEntry.orderIdx（toCompress 的最后一条的 id）
    const lastCompressedId = toCompress[toCompress.length - 1]?.id;
    if (lastCompressedId) {
      const orig = pending.find((e) => e.id === lastCompressedId);
      if (orig) this.state.compressedUpTo = orig.orderIdx;
    }
    // toKeep 变量保留语义清晰，不实际使用（留给未来 adapter 逻辑参考）
    void toKeep;
  }

  async snapshot(): Promise<MemorySnapshot> {
    return {
      kind: 'legacy-v2',
      summaries: [...this.state.summaries],
      pinned: structuredClone(this.state.pinned),
      compressedUpTo: this.state.compressedUpTo,
    };
  }

  async restore(snap: MemorySnapshot): Promise<void> {
    if (snap.kind === 'legacy-v2') {
      // 新格式
      this.state = {
        summaries: [...((snap.summaries ?? []) as string[])],
        pinned: structuredClone((snap.pinned ?? []) as MemoryEntry[]),
        compressedUpTo: (snap.compressedUpTo as number | undefined) ?? -1,
      };
      return;
    }
    if (snap.kind === 'legacy-v1') {
      // 老格式兼容：从 entries 里提取 pinned=true 的条目 + 保留 summaries
      const oldEntries = (snap.entries ?? []) as MemoryEntry[];
      this.state = {
        summaries: [...((snap.summaries ?? []) as string[])],
        pinned: structuredClone(oldEntries.filter((e) => e.pinned)),
        // 老 snapshot 没有 compressedUpTo；置 -1 + 下次 maybeCompact 从头看，
        // 可能会对老叙事"二次摘要"。实际影响：少量冗余 summary，LLM 能忍受
        compressedUpTo: -1,
      };
      return;
    }
    throw new Error(
      `LegacyMemory cannot restore from kind: ${String(snap.kind)}`,
    );
  }

  async reset(): Promise<void> {
    this.state = { summaries: [], pinned: [], compressedUpTo: -1 };
  }

  // ─── Internal helpers ────────────────────────────────────────────

  /** 从 reader 拉近期 entries 并映射成 MemoryEntry（供 retrieve 的 keyword match 用） */
  private async readRecentMemoryEntries(): Promise<MemoryEntry[]> {
    if (!this.reader) return [];
    // 检索的可见窗口比 messages 窗口大一些（用户的 query 可能命中较早条目）
    const raw = await this.reader.readRecent({
      limit: Math.max(this.config.recencyWindow * 4, 100),
      kinds: ['narrative', 'player_input'],
    });
    return narrativeEntriesToMemoryEntries(raw);
  }

  /**
   * 空格分词 + 词频打分，按分数降序。空 query → 空数组（不把全部历史丢给 tool）。
   */
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
