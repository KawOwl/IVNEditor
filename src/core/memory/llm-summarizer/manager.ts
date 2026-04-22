/**
 * LLMSummarizerMemory —— 和 LegacyMemory 平行的 Memory adapter
 *
 * 设计原则：**不继承 LegacyMemory**。虽然两者大部分行为重合（appendTurn /
 * pin / retrieve 等），但通过继承共享会把"是否共享某段实现"的权利交给基类，
 * 将来改 legacy 的细节就会牵扯到 LLMSummarizer。作为独立 adapter 可以各自
 * 演化（比如 LLMSummarizer 未来想加"压缩前先 dedupe"、"摘要 stream 返回"
 * 这类功能），不影响 legacy。
 *
 * 与 legacy 的唯一功能性差别：
 *   - compressFn 从截断拼接换成真 LLM 调用（质量显著提升）
 *   - snapshot.kind = 'llm-summarizer-v1'（和 legacy 的 'legacy-v1' 隔离）
 *     → 切换 provider 时 restore 会抛 kind 不匹配错，这是 opaque snapshot
 *       契约的预期行为
 *
 * 行为相同点（有意和 legacy 对齐，避免引入非压缩相关的变化）：
 *   - 每轮 appendTurn 写入，压缩按 token 阈值触发，pinned 不参与压缩
 *   - pinned entries 进入 retrieve().summary 的 `[重要] ...` 列表
 *   - getRecentAsMessages 按 recencyWindow 窗口 + budget cap
 *   - 关键词匹配给 query_memory tool
 *
 * 代码上和 legacy 会有明显重复 —— 这是"平行独立"的代价，换来演化自由度。
 * 如果未来两个 adapter 积累出确实值得共享的小块（比如 entries 管理），
 * 再提取成 `memory/shared/` 模块。
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
import { makeLLMCompressFn, type CompressFn } from './compress';

// ============================================================================
// Snapshot kind（adapter 间隔离）
// ============================================================================

const SNAPSHOT_KIND = 'llm-summarizer-v1';

// ============================================================================
// Internal state
// ============================================================================

interface LLMSummarizerState {
  entries: MemoryEntry[];
  summaries: string[];
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
  private state: LLMSummarizerState = { entries: [], summaries: [] };
  private readonly compressFn: CompressFn;

  constructor(
    private readonly config: MemoryConfig,
    llmClient: LLMClient,
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
      turn: -1,
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
   * summary = 真 LLM 生成的摘要列表 + pinned entries
   *
   * 相比 legacy，summaries 数组里的每条都是一段 3-5 句话的情节摘要，
   * 而不是截断拼接的原文片段。这是 LLMSummarizer 的核心价值。
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
   * 压缩一轮旧 entries 成 summary 追加到 summaries[]。
   *
   * 唯一和 legacy 的差别：compressFn 真的调 LLM（makeLLMCompressFn 的产物），
   * 所以这一步会额外花一次 LLM 调用（~几秒 + 一点 token 钱）。
   * 触发时机和 legacy 一致：总 token 超 compressionThreshold 时才跑。
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

    this.state.entries = [...pinned, ...toKeep];
  }

  async snapshot(): Promise<MemorySnapshot> {
    return {
      kind: SNAPSHOT_KIND,
      entries: structuredClone(this.state.entries),
      summaries: [...this.state.summaries],
    };
  }

  async restore(snap: MemorySnapshot): Promise<void> {
    if (snap.kind !== SNAPSHOT_KIND) {
      throw new Error(
        `LLMSummarizerMemory cannot restore from kind: ${String(snap.kind)}. ` +
          `提示：adapter 间 snapshot 不可互换；切换 provider 需新建 playthrough。`,
      );
    }
    this.state = {
      entries: structuredClone((snap.entries ?? []) as MemoryEntry[]),
      summaries: [...((snap.summaries ?? []) as string[])],
    };
  }

  async reset(): Promise<void> {
    this.state = { entries: [], summaries: [] };
  }

  // ─── Internal helpers ──────────────────────────────────────────────

  private getTotalTokenCount(): number {
    return this.state.entries.reduce((s, e) => s + e.tokenCount, 0);
  }

  /** 空格分词 + 词频打分，和 legacy 对齐 */
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
