/**
 * MemoraxMemory —— 接 self-hosted Memorax 服务的 Memory adapter
 *
 * 跟 mem0 同模型（远端语义检索 + 本地短期窗口），但用 Memorax 的多层 ID 模型：
 *   - user_id  = scope.userId（IVN 系统的玩家 user_id；跨 playthrough 聚合用）
 *   - agent_id = scope.playthroughId（按存档隔离；retrieve 强制 filter）
 *   - app_id   = options.appId ?? 'ivn-editor'
 *   - session_id 跳（Memorax 要求 UUID，playthroughId 已经做隔离，多塞反而坑）
 *
 * 失败语义（关键，跟 ParallelMemory 配合）：
 *   - retrieve：HTTP/网络失败时**不抛**，返回 `{summary:'', meta:{error}}`，
 *     ParallelMemory 检 meta.error 决定 fallback 到 mem0
 *   - appendTurn / pin：失败 console.error 不冒；mem0 那边走 fan-out 不会受影响
 *   - reset：Memorax 没有 memory-delete API，只清本地窗口（云端按 agent_id
 *     永久保留；剧本重开会换 playthroughId，自然天然隔离）
 *
 * deletionFilter 入参是给 ANN.1 留的 forward-compat 槽位（dreamy-germain 分支
 * 的 MemoryDeletionFilter）。当前 main 没那 interface 所以 inline type，rebase
 * 时换成正式 import 即可。
 */

import { estimateTokens } from '@ivn/core/tokens';
import type { MemoryEntry, MemoryConfig } from '@ivn/core/types';
import type {
  Memory,
  MemoryDeletionFilter,
  MemoryRetrieval,
  MemorySnapshot,
  MemoryScope,
  RecentMessagesResult,
} from '#internal/memory/types';
import {
  createMemoraxClient,
  MemoraxError,
  type MemoraxClient,
  type MemoraxFilterCondition,
} from '#internal/memory/memorax/client';
import { entryToMemoraxMessage } from '#internal/memory/memorax/mapping';

const SNAPSHOT_KIND = 'memorax-v1';
const DEFAULT_APP_ID = 'ivn-editor';

interface MemoraxState {
  /** 本地短期窗口 —— 供 getRecentAsMessages 用。云端记忆不在这里。 */
  recentEntries: MemoryEntry[];
}

let counter = 0;
function generateId(): string {
  return `mem-memorax-${Date.now()}-${++counter}`;
}

export interface MemoraxAdapterOptions {
  baseUrl: string;
  apiKey: string;
  appId?: string;
  /** 默认 30s。复用 client 同名字段。 */
  timeoutMs?: number;
  /** 注入 client（测试用）；不传则按 baseUrl/apiKey 自己 build */
  client?: MemoraxClient;
}

export class MemoraxMemory implements Memory {
  readonly kind = 'memorax';

  private state: MemoraxState = { recentEntries: [] };
  private readonly client: MemoraxClient;
  private readonly userId: string;
  private readonly agentId: string;
  private readonly appId: string;
  private readonly retrieveTopK: number;
  private readonly maxRecentEntries: number;

  constructor(
    scope: MemoryScope,
    private readonly config: MemoryConfig,
    options: MemoraxAdapterOptions,
    /**
     * ANN.1：删除过滤器。retrieve 时过滤掉被标 memorax results。
     * memorax 当前没有 memory-delete API；adapter 边界 filter 即可。
     */
    private readonly deletionFilter?: MemoryDeletionFilter,
  ) {
    this.client =
      options.client ??
      createMemoraxClient({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        timeoutMs: options.timeoutMs,
      });
    this.userId = scope.userId;
    this.agentId = scope.playthroughId;
    this.appId = options.appId ?? DEFAULT_APP_ID;
    this.retrieveTopK = (config.providerOptions?.topK as number | undefined) ?? 10;
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
    if (this.state.recentEntries.length > this.maxRecentEntries) {
      this.state.recentEntries = this.state.recentEntries.slice(-this.maxRecentEntries);
    }

    // async_mode=true：服务端入队后立即返回（Memorax 自己异步跑 LLM 抽取），
    // 避免每轮 generate 被 Memorax 5-30s 的同步抽取阻塞。失败靠服务端
    // PENDING 队列重试 + 我们的 console.error log。
    this.client
      .add({
        messages: [entryToMemoraxMessage(entry)],
        user_id: this.userId,
        agent_id: this.agentId,
        app_id: this.appId,
        metadata: { source: 'gameplay', turn: params.turn, role: params.role },
        async_mode: true,
      })
      .catch((err) => {
        console.error('[MemoraxMemory] appendTurn flush failed:', err);
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

    // pin 用同步 add（async_mode=false）—— pin 是显式"重要记忆"语义，不能容忍丢失
    try {
      await this.client.add({
        messages: [entryToMemoraxMessage(entry)],
        user_id: this.userId,
        agent_id: this.agentId,
        app_id: this.appId,
        metadata: { source: 'pin', pinned: true, tags: tags ?? [] },
        async_mode: false,
      });
    } catch (err) {
      console.error('[MemoraxMemory] pin flush failed:', err);
    }

    return entry;
  }

  // ─── Read ──────────────────────────────────────────────────────────

  async retrieve(query: string): Promise<MemoryRetrieval> {
    if (!query.trim()) {
      return { summary: '', entries: [], meta: { skipped: 'empty-query' } };
    }

    const deletedIds = await this.loadDeletedIds();

    // 强制按 playthroughId 隔离：哪怕 user_id 跨多 playthrough，也只看本档的
    const filters: { and: MemoraxFilterCondition[] } = {
      and: [{ agent_id: { eq: this.agentId } }],
    };

    try {
      const results = await this.client.search({
        query,
        user_id: this.userId,
        filters,
        top_k: this.retrieveTopK,
      });

      if (!results.length) {
        return { summary: '', entries: [], meta: { topK: this.retrieveTopK, returned: 0 } };
      }

      // ANN.1：用 memorax result.id 做 filter；同时投影成 MemoryEntry 让客户端
      // UI 拿到稳定 id 标删。memorax cloud 数据本身不删，adapter 边界 filter 即可。
      const filtered = deletedIds.size > 0
        ? results.filter((r) => !deletedIds.has(r.id))
        : results;

      if (filtered.length === 0) {
        return {
          summary: '',
          entries: [],
          meta: {
            topK: this.retrieveTopK,
            returned: results.length,
            filteredOut: deletedIds.size > 0 ? results.length : 0,
          },
        };
      }

      const summary = ['[Relevant Memories]', ...filtered.map((r) => `- ${r.memory}`)].join('\n');
      const entries: MemoryEntry[] = filtered.map((r) => ({
        id: r.id,
        turn: -1,
        role: 'system',
        content: r.memory,
        tokenCount: estimateTokens(r.memory),
        timestamp: r.created_at ? Date.parse(r.created_at) : Date.now(),
      }));
      return {
        summary,
        entries,
        meta: {
          topK: this.retrieveTopK,
          returned: results.length,
          filteredOut: deletedIds.size > 0 ? results.length - filtered.length : 0,
        },
      };
    } catch (err) {
      // 不抛——保持 game-session 鲁棒；ParallelMemory 检 meta.error 决定 fallback
      const reason = err instanceof MemoraxError ? `${err.reason}: ${err.message}` : String(err);
      console.error('[MemoraxMemory] retrieve failed:', reason);
      return { summary: '', entries: [], meta: { error: reason } };
    }
  }

  /** ANN.1：失败静默返回空集合，详见 LegacyMemory 同名方法。*/
  private async loadDeletedIds(): Promise<ReadonlySet<string>> {
    if (!this.deletionFilter) return new Set();
    try {
      return await this.deletionFilter.listDeleted();
    } catch (err) {
      console.warn('[MemoraxMemory] deletionFilter.listDeleted failed:', err);
      return new Set();
    }
  }

  async getRecentAsMessages(opts: { budget: number }): Promise<RecentMessagesResult> {
    const window = this.config.recencyWindow;
    const recent = this.state.recentEntries.slice(-window);

    // 与 mem0 adapter 同口径：本地窗口仅 string-only message，不含 tool-call
    // 历史。ParallelMemory 不调这个方法（走 coreEventReader 拿 canonical 来源），
    // 所以单独使用 MemoraxMemory 时这里的 string-only 行为是"够用"基线。
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
   * Memorax 跟 mem0 一样把 flush 放进 appendTurn/pin 即时做，maybeCompact 留 no-op。
   * 原因：VN 模式下 generate() 因 signal_input_needed 长期挂起，maybeCompact
   * 调用点轮不到。
   */
  async maybeCompact(): Promise<void> {
    /* no-op */
  }

  async snapshot(): Promise<MemorySnapshot> {
    return {
      kind: SNAPSHOT_KIND,
      recentEntries: structuredClone(this.state.recentEntries),
      userId: this.userId,
      agentId: this.agentId,
      appId: this.appId,
    };
  }

  async restore(snap: MemorySnapshot): Promise<void> {
    if (snap.kind !== SNAPSHOT_KIND) {
      throw new Error(
        `MemoraxMemory cannot restore from kind: ${String(snap.kind)}. ` +
          `提示：adapter 间 snapshot 不可互换；切换 provider 需新建 playthrough。`,
      );
    }
    this.state = {
      recentEntries: structuredClone((snap.recentEntries ?? []) as MemoryEntry[]),
    };
  }

  /**
   * Memorax 当前没有 memory-delete API。reset 只清本地窗口；云端按 agent_id
   * 永久保留。剧本重开会用新的 playthroughId（→ 新 agent_id），新档自然不会
   * 看到老档的记忆，所以业务侧不破。
   *
   * 真要清云端：手动从 Memorax 的 admin API 删（目前没暴露 user-facing endpoint）。
   */
  async reset(): Promise<void> {
    this.state = { recentEntries: [] };
  }
}
