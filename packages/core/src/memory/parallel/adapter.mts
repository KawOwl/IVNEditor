/**
 * ParallelMemory —— fan-out 写、读优先级 fallback 的复合 Memory adapter
 *
 * 写（appendTurn / pin / maybeCompact / reset）：
 *   - 所有 child Promise.allSettled，失败 console.error 不冒
 *   - 两端都拿到数据，将来想"关掉一边"只改 children 列表
 *
 * 读（retrieve）：
 *   - 按 children 顺序逐个尝试
 *   - 优先 child 抛异常 OR meta.error 存在 → 视为失败，落到下一个
 *   - 第一个成功的（含空结果）就用，meta.source 标 child name
 *   - 全失败 → 返回空 summary + meta.source='all-failed'
 *
 * getRecentAsMessages 不走 child：
 *   - 走 coreEventReader（canonical chat 来源，跟 noop / messages-builder 一致）
 *   - child 各自维护的 recentEntries 是各 adapter 内部状态，parallel 层不混用
 *
 * snapshot / restore：
 *   - { kind:'parallel-v1', children:[{name, snapshot}] }
 *   - restore 按 name 匹配回 child；missing name 安全跳过（兼容增减 child）
 *
 * 注意：ParallelMemory 自己不读 mem0/memorax 的 ID 模型 —— 那些差异封在各 child 里。
 *       parallel 层只看 Memory interface，做编排。
 */

import type { ModelMessage } from 'ai';
import {
  buildMessagesFromCoreEventHistory,
  capMessagesByBudgetFromTail,
  type CoreEventHistoryReader,
} from '#internal/game-session/core-event-history';
import type {
  Memory,
  MemoryRetrieval,
  MemorySnapshot,
  RecentMessagesResult,
} from '#internal/memory/types';
import type { MemoryConfig, MemoryEntry } from '@ivn/core/types';

const SNAPSHOT_KIND = 'parallel-v1';

export interface ParallelMemoryChild {
  name: string;
  memory: Memory;
}

export class ParallelMemory implements Memory {
  readonly kind = 'parallel';

  constructor(
    private readonly config: MemoryConfig,
    private readonly children: ReadonlyArray<ParallelMemoryChild>,
    private readonly coreEventReader?: CoreEventHistoryReader,
  ) {
    if (children.length === 0) {
      throw new Error('ParallelMemory requires at least one child');
    }
  }

  // ─── Write fan-out ─────────────────────────────────────────────────

  async appendTurn(params: {
    turn: number;
    role: MemoryEntry['role'];
    content: string;
    tokenCount: number;
    tags?: string[];
  }): Promise<MemoryEntry> {
    const settled = await Promise.allSettled(
      this.children.map((c) => c.memory.appendTurn(params)),
    );
    this.logRejections('appendTurn', settled);

    // 至少返回一个 entry 给 caller。优先取第一个成功的 child；全失败则
    // 综合一个本地 entry（保证 caller 能继续）
    const fulfilled = settled.find((r) => r.status === 'fulfilled');
    if (fulfilled && fulfilled.status === 'fulfilled') return fulfilled.value;

    return {
      id: `mem-parallel-${Date.now()}`,
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
    const settled = await Promise.allSettled(
      this.children.map((c) => c.memory.pin(content, tags)),
    );
    this.logRejections('pin', settled);

    const fulfilled = settled.find((r) => r.status === 'fulfilled');
    if (fulfilled && fulfilled.status === 'fulfilled') return fulfilled.value;

    return {
      id: `mem-parallel-pin-${Date.now()}`,
      turn: -1,
      role: 'system',
      content,
      tokenCount: 0,
      timestamp: Date.now(),
      tags,
      pinned: true,
    };
  }

  async maybeCompact(): Promise<void> {
    const settled = await Promise.allSettled(
      this.children.map((c) => c.memory.maybeCompact()),
    );
    this.logRejections('maybeCompact', settled);
  }

  async reset(): Promise<void> {
    const settled = await Promise.allSettled(this.children.map((c) => c.memory.reset()));
    this.logRejections('reset', settled);
  }

  // ─── Read with priority fallback ──────────────────────────────────

  async retrieve(query: string, hints?: Record<string, unknown>): Promise<MemoryRetrieval> {
    const attempts: Array<{ name: string; error: string }> = [];

    for (const child of this.children) {
      try {
        const result = await child.memory.retrieve(query, hints);
        const errMsg = result.meta?.error;
        if (typeof errMsg === 'string') {
          attempts.push({ name: child.name, error: errMsg });
          console.warn(
            `[ParallelMemory] retrieve via ${child.name} surfaced error, falling back: ${errMsg}`,
          );
          continue;
        }
        return {
          ...result,
          meta: {
            ...(result.meta ?? {}),
            source: child.name,
            attempted: attempts.length === 0 ? undefined : attempts,
          },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        attempts.push({ name: child.name, error: msg });
        console.warn(
          `[ParallelMemory] retrieve via ${child.name} threw, falling back: ${msg}`,
        );
      }
    }

    return {
      summary: '',
      entries: [],
      meta: { source: 'all-failed', attempted: attempts },
    };
  }

  async getRecentAsMessages(opts: { budget: number }): Promise<RecentMessagesResult> {
    if (!this.coreEventReader) {
      return { messages: [] as ModelMessage[], tokensUsed: 0 };
    }
    const items = await this.coreEventReader.readRecent({ limit: this.config.recencyWindow });
    const projected = buildMessagesFromCoreEventHistory(items);
    return capMessagesByBudgetFromTail(projected, opts.budget);
  }

  // ─── Snapshot fan-out ─────────────────────────────────────────────

  async snapshot(): Promise<MemorySnapshot> {
    const childSnapshots = await Promise.all(
      this.children.map(async (c) => ({
        name: c.name,
        snapshot: await c.memory.snapshot(),
      })),
    );
    return { kind: SNAPSHOT_KIND, children: childSnapshots };
  }

  async restore(snap: MemorySnapshot): Promise<void> {
    if (snap.kind !== SNAPSHOT_KIND) {
      throw new Error(
        `ParallelMemory cannot restore from kind: ${String(snap.kind)}. ` +
          `提示：adapter 间 snapshot 不可互换；切换 provider 需新建 playthrough。`,
      );
    }

    const entries = (snap.children ?? []) as Array<{ name: string; snapshot: MemorySnapshot }>;
    const byName = new Map(entries.map((e) => [e.name, e.snapshot]));

    // 按 child name 分发；missing 安全跳过（child 列表变了/snapshot 老了）
    const settled = await Promise.allSettled(
      this.children
        .filter((c) => byName.has(c.name))
        .map((c) => c.memory.restore(byName.get(c.name)!)),
    );
    this.logRejections('restore', settled);
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private logRejections(op: string, settled: PromiseSettledResult<unknown>[]): void {
    settled.forEach((r, i) => {
      if (r.status === 'rejected') {
        const name = this.children[i]?.name ?? `child-${i}`;
        console.error(`[ParallelMemory] ${name} ${op} failed:`, r.reason);
      }
    });
  }
}
