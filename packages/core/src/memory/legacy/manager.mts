/**
 * LegacyMemory —— Memory Refactor v2（2026-04-23）：reader-based 实现
 *
 * 见 .claude/plans/memory-refactor-v2.md 和 architecture-alignment.md
 *
 * 和旧版本（2026-04-11 的 refactor v1）的区别：
 *   - 不再持有 `state.entries` —— 对话历史通过 CoreEventHistoryReader 从
 *     canonical core_event_envelopes 投影
 *   - 内部状态瘦身为：summaries（派生摘要）+ pinned（pin_memory 显式记）+
 *     compressedUpTo（压缩游标）
 *   - snapshot 格式 v1 → v2：去掉 entries 字段
 *
 * 保留：
 *   - compressFn 截断拼接契约不动
 *   - pinned entries 进入 retrieve().summary 的 `[重要]` 前缀列表
 *   - 空 query 合法，返回空 entries（keyword match 在 reader 拿到的条目上跑）
 *   - maybeCompact 由 token 阈值触发
 */

import { estimateTokens } from '@ivn/core/tokens';
import type { MemoryEntry, MemoryConfig } from '@ivn/core/types';
import {
  buildMessagesFromCoreEventHistory,
  capMessagesByBudgetFromTail,
  projectCoreEventHistoryToMemoryEntries,
} from '#internal/game-session/core-event-history';
import type { CoreEventHistoryReader } from '#internal/game-session/core-event-history';
import type {
  Memory,
  MemoryRetrieval,
  MemorySnapshot,
  RecentMessagesResult,
} from '#internal/memory/types';

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
 *   - 新增 `pinned`：pin_memory tool 显式记的条目
 *   - 新增 `compressedUpTo`：记录最后一次压缩覆盖到哪条 CoreEvent sequence（-1 = 从未压缩）
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
     * 从 core_event_envelopes 读历史。
     * undefined 时（单测场景）retrieve / getRecentAsMessages 保守返回空；
     * maybeCompact 变成 no-op。生产路径 session-manager 必传。
     */
    private readonly coreEventReader?: CoreEventHistoryReader,
  ) {}

  // ─── Write ─────────────────────────────────────────────────────────

  /**
   * Memory Refactor v2：appendTurn 不再写 state.entries。
   * 上游（game-session）仍然会调 —— 保留签名兼容，作为"轮次推进"通知；
   * 真正的对话原件由 CoreEvent 日志持久化。
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
    const parts = [
      ...this.state.summaries,
      ...this.state.pinned.map((entry) => `[重要] ${entry.content}`),
    ];

    const recent = await this.readRecentMemoryEntries();
    return {
      summary: parts.join('\n\n'),
      entries: this.keywordMatch(query, recent),
    };
  }

  /**
   * 从 reader 读最近 recencyWindow 条 entries，投影成 AI SDK 原生 ModelMessage[]
   * （含 tool-call / tool-result parts），然后从尾部按 budget 裁剪。
   *
   * 2026-04-24 重写：
   *   - 之前 `kinds: ['narrative', 'player_input']` 过滤掉了 tool_call /
   *     signal_input，LLM 看不到自己过去 turn 的工具调用历史。放开 kinds
   *     白名单（不传 = 全部 kinds），让 messages-builder 能正确投影完整历史。
   *   - 预算裁剪从"头部累积直到溢出"改成"尾部累积保留最新"。原逻辑在 budget
   *     紧时会丢掉**最近**的对话（保留最早的 N 条），对 LLM 注意力是反直觉的；
   *     capMessagesByBudgetFromTail 从尾部往前算，保留最新的若干条，并保护
   *     `[assistant(含 tool-call), tool(含 tool-result)]` 配对不被切断。
   *
   * recencyWindow 的语义不变：先限制到最近 N 条 entry，再做预算裁剪。
   * N 目前是 20 —— tool history 进来后一条 assistant 可能带 2-3 个 tool-call
   * + 相应 tool message，token 密度比只存 narration 高约 10-30%。如果上线后
   * budget 频繁顶满导致裁剪激进，考虑把 recencyWindow 从 20 调到 12-15。
   */
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

  // ─── Lifecycle ────────────────────────────────────────────────────

  /**
   * 从 `compressedUpTo+1` 往后读，如果总 token 超阈值，把 [最早, N-recencyWindow] 压成
   * 一条新 summary，推进 compressedUpTo 到被压缩段的最后 orderIdx。
   *
   * reader 不存在时（单测）no-op。
   */
  async maybeCompact(): Promise<void> {
    if (!this.coreEventReader) return;

    const pendingEvents = await this.coreEventReader.readRange({
      fromSequence: this.state.compressedUpTo + 1,
    });
    const memoryEntries = projectCoreEventHistoryToMemoryEntries(pendingEvents);
    const totalTokens = memoryEntries.reduce((s, e) => s + e.tokenCount, 0);
    if (totalTokens <= this.config.compressionThreshold) return;

    // 保留最新 recencyWindow 条不压缩；更早的做 compressFn
    const toKeep = memoryEntries.slice(-this.config.recencyWindow);
    const toCompress = memoryEntries.slice(0, -this.config.recencyWindow);
    if (toCompress.length === 0) return;

    const summary = await this.compressFn(toCompress, this.config.compressionHints);
    this.state.summaries.push(summary);

    const lastCompressed = toCompress[toCompress.length - 1];
    if (lastCompressed) this.state.compressedUpTo = lastCompressed.sequence;
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
    if (!this.coreEventReader) return [];
    // 检索的可见窗口比 messages 窗口大一些（用户的 query 可能命中较早条目）
    const raw = await this.coreEventReader.readRecent({
      limit: Math.max(this.config.recencyWindow * 8, 200),
    });
    return projectCoreEventHistoryToMemoryEntries(raw);
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
