/**
 * Mem0Memory —— 和 legacy / llm-summarizer 平行的 Memory adapter
 *
 * 底层是 mem0 Platform 云服务（托管的向量检索 + 自动摘要 + 去重）。
 * 我们只当 SDK 用户，不管 embedding / store / prompt 选择。
 *
 * ## 职责切分（和本地 adapter 不同）
 *
 * Legacy / LLMSummarizer 在本地维护**全部状态**（entries + summaries）。
 * Mem0 不同：
 *   - 长期记忆归 mem0 云端（整条 entries、它做摘要、它做检索）
 *   - 本地只留**短期滑动窗口**（recentEntries）供 getRecentAsMessages 用
 *     —— 因为 mem0 的 retrieve 是语义相关度，不是严格时序，不能顶替
 *     messages[] 通道的 "最近 N 条原文" 语义
 *
 * ## snapshot 设计
 *
 * snapshot 只存本地这部分：recentEntries + chapterTag（如果有）。
 * 云端数据不存 snapshot —— 断线重连时重新 restore 本地窗口，长期记忆
 * 从 mem0 retrieve 依然能拿到。playthroughId 作为 mem0 user_id，自然等同。
 *
 * ## 故障降级
 *
 * mem0 是网络服务，任何云端调用都可能失败。原则：
 *   - retrieve 失败 → 返回空 summary，不阻断游戏
 *   - flush 失败 → 记 log 继续，next flush 再试
 *   - delete 失败 → 记 log
 * 都**不向上抛**，让玩家体验不因 mem0 抖动中断。
 *
 * ## 空 query 契约
 *
 * 按 Memory 接口约定，retrieve 收到空串必须合法返回。Mem0 的 search API
 * 对空串可能报 400，我们在进 search 之前挡住：空 query → 直接返回空 summary。
 * （未来想改为"空 query 拉最近 N 条 memory"可以在这里加 getAll 调用。）
 */

import MemoryClient from 'mem0ai';
import { estimateTokens } from '@ivn/core/tokens';
import type { MemoryEntry, MemoryConfig } from '@ivn/core/types';
import type {
  Memory,
  MemoryRetrieval,
  MemorySnapshot,
  MemoryScope,
  RecentMessagesResult,
} from '#internal/memory/types';
// Memory Refactor v2：Mem0 不需要 CoreEventHistoryReader —— 云端做长期记忆检索，
// 本地 recentEntries 窗口承担 getRecentAsMessages。factory 传不传 reader 都行，
// mem0 的 Mem0Memory constructor 不接受也不需要。
import { entryToMem0Message, playthroughToMem0UserId } from '#internal/memory/mem0/mapping';

// ============================================================================
// Snapshot kind（adapter 间隔离）
// ============================================================================

const SNAPSHOT_KIND = 'mem0-v1';

// ============================================================================
// Internal state
// ============================================================================

interface Mem0State {
  /** 本地短期窗口 —— 供 getRecentAsMessages 用。不含云端数据。 */
  recentEntries: MemoryEntry[];
}

// ============================================================================
// ID generator
// ============================================================================

let counter = 0;
function generateId(): string {
  return `mem-mem0-${Date.now()}-${++counter}`;
}

// ============================================================================
// Mem0Memory
// ============================================================================

export class Mem0Memory implements Memory {
  readonly kind = 'mem0';

  private state: Mem0State = { recentEntries: [] };
  private readonly client: MemoryClient;
  private readonly userId: string;
  private readonly retrieveTopK: number;
  /** 本地窗口最大保留条数 —— 避免内存无限增长 */
  private readonly maxRecentEntries: number;

  constructor(
    scope: MemoryScope,
    private readonly config: MemoryConfig,
    apiKey: string,
  ) {
    this.client = new MemoryClient({ apiKey });
    this.userId = playthroughToMem0UserId(scope.playthroughId);
    this.retrieveTopK =
      (config.providerOptions?.topK as number | undefined) ?? 10;
    // 本地窗口上限 —— recencyWindow 的 3 倍作为缓冲
    // （pin / tool 查询可能想看超窗口的近期数据）
    this.maxRecentEntries = Math.max(this.config.recencyWindow * 3, 30);
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

    this.state.recentEntries.push(entry);
    // 本地窗口 cap，防内存泄漏
    if (this.state.recentEntries.length > this.maxRecentEntries) {
      this.state.recentEntries = this.state.recentEntries.slice(
        -this.maxRecentEntries,
      );
    }

    // 立即 fire-and-forget flush 到 mem0 云端。不 await —— appendTurn 返回要快，
    // 不能被 mem0 HTTP RTT 阻塞。失败在 .catch 里 log，依赖 mem0 自己的 PENDING
    // 队列重试（实测 add 只是 100ms 接收请求，不等入库完成）。
    //
    // 之前版本用 pendingForFlush + maybeCompact 批量，但 VN 游戏的 generate()
    // 在 signal_input_needed 挂起时不返回，maybeCompact 永远轮不到 —— 只好
    // 在每条 appendTurn 时 flush。
    this.client
      .add([entryToMem0Message(entry)], {
        userId: this.userId,
        metadata: { source: 'gameplay', turn: params.turn, role: params.role },
      })
      .catch((err) => {
        console.error('[Mem0Memory] appendTurn flush failed:', err);
      });

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

    this.state.recentEntries.push(entry);
    // pin 的条目**立刻 flush**到 mem0（带 metadata.pinned=true）—— 如果等
    // 批量，中间断线可能丢失 pin，而 pin 是明确的"重要记忆"语义，
    // 不能容忍丢失。成本也只是一次额外 HTTP。
    try {
      await this.client.add(
        [entryToMem0Message(entry)],
        {
          userId: this.userId,
          metadata: { pinned: true, tags: tags ?? [] },
        },
      );
    } catch (err) {
      console.error('[Mem0Memory] pin flush failed:', err);
    }
    return entry;
  }

  // ─── Read ──────────────────────────────────────────────────────────

  /**
   * 走 mem0 的语义检索。空 query → 直接返回空 summary（不调 search，
   * 省一次 HTTP + 避免 mem0 对空串的边缘行为）。
   */
  async retrieve(query: string): Promise<MemoryRetrieval> {
    if (!query.trim()) {
      return { summary: '', entries: [], meta: { skipped: 'empty-query' } };
    }

    try {
      const { results } = await this.client.search(query, {
        // mem0 SDK 的 search / getAll / deleteAll 不接受顶层 userId，
        // 必须走 filters.user_id（snake_case，直转 API payload）
        filters: { user_id: this.userId },
        topK: this.retrieveTopK,
      });

      if (!results.length) {
        return { summary: '', entries: [], meta: { topK: this.retrieveTopK } };
      }

      // 把相关 memory 条目拼成一段 summary 喂进 _engine_memory section
      const summaryParts = [
        '[Relevant Memories]',
        ...results
          .map((result) => result.memory ?? result.data?.memory ?? '')
          .filter(Boolean)
          .map((text) => `- ${text}`),
      ];

      return {
        summary: summaryParts.join('\n'),
        entries: [],  // mem0 的 memory 不是 MemoryEntry 格式，query_memory tool 只用 summary
        meta: {
          topK: this.retrieveTopK,
          returned: results.length,
          scores: results.map((r) => r.score).filter((s) => s !== undefined),
        },
      };
    } catch (err) {
      console.error('[Mem0Memory] retrieve failed:', err);
      return {
        summary: '',
        entries: [],
        meta: { error: String(err) },
      };
    }
  }

  async getRecentAsMessages(
    opts: { budget: number },
  ): Promise<RecentMessagesResult> {
    const window = this.config.recencyWindow;
    const recent = this.state.recentEntries.slice(-window);

    // 注意：mem0 adapter 仅从本地 `recentEntries` 缓存读（MemoryEntry 只有
    // {role, content: string}），没接 CoreEventHistoryReader，所以**本版本
    // 还拿不到 tool-call 历史**。返回类型升级到 ModelMessage[] 让接口统一，
    // 但实际消息仍然只有纯文本 narration + player_input。
    //
    // TODO（后续）：给 Mem0 也注入 CoreEventHistoryReader，用 messages-builder
    // 投影 tool-call parts，达到和 legacy / llm-summarizer 一致的行为。当前
    // Mem0 不是默认 provider，临时保留 string-only 行为不影响生产。
    const messages: RecentMessagesResult['messages'] = [];
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

  /**
   * 每轮 generate 结束后调用：批量 flush 本轮新增的 entries 到 mem0。
   *
   * 调用层时机已和 legacy / llm-summarizer 对齐（game-session T6）。
   * 如果一轮内 appendTurn 了多条（receive + generate），此处一次 HTTP 搞定。
   * 失败时吞掉错误：pending 条目保留在队列里，下次 flush 会重试（顺带
   * 处理重试的副作用 —— mem0 的 add 会基于 hash 去重，重复 add 不会造成
   * 记忆膨胀）。
   */
  /**
   * mem0 adapter 的 maybeCompact 是 no-op。
   *
   * 原因：VN 模式下 game-session 的 generate() 因 signal_input_needed 挂起
   * 而几乎不返回，T6 maybeCompact 的调用点永远轮不到。改为 appendTurn 时
   * 直接 fire-and-forget flush 到 mem0。
   *
   * （legacy / llm-summarizer 保留 maybeCompact 逻辑没问题 —— 它们依赖的是
   * total token 超阈值触发，本地同步完成，即便调用稀少也只是"压缩延后"。）
   */
  async maybeCompact(): Promise<void> {
    // no-op; flush 在 appendTurn / pin 里即时完成
  }

  async snapshot(): Promise<MemorySnapshot> {
    return {
      kind: SNAPSHOT_KIND,
      // 本地窗口持久化 —— 断线重连恢复短期 messages[] 不丢
      recentEntries: structuredClone(this.state.recentEntries),
      // userId 存一份便于调试（不读回，构造时从 scope 拿）
      userId: this.userId,
    };
  }

  async restore(snap: MemorySnapshot): Promise<void> {
    if (snap.kind !== SNAPSHOT_KIND) {
      throw new Error(
        `Mem0Memory cannot restore from kind: ${String(snap.kind)}. ` +
          `提示：adapter 间 snapshot 不可互换；切换 provider 需新建 playthrough。`,
      );
    }
    this.state = {
      recentEntries: structuredClone(
        (snap.recentEntries ?? []) as MemoryEntry[],
      ),
    };
  }

  /**
   * 剧本重开时清空。会**真的删 mem0 云端**这个 playthrough 的所有记忆。
   * 失败吞掉错（reset 多用于测试，失败也不该卡住）。
   */
  async reset(): Promise<void> {
    this.state = { recentEntries: [] };
    try {
      await this.client.deleteAll({ userId: this.userId });
    } catch (err) {
      console.error('[Mem0Memory] cloud deleteAll failed (ignored):', err);
    }
  }
}
