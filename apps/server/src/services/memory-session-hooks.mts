/**
 * Session-bound factories for ANN.1 memory hooks.
 *
 * 把 server 的 service 层封装成 core 层接受的窄接口（MemoryDeletionFilter +
 * RetrievalLogger），保持 core 不依赖 #internal/services 任何具体实现。
 *
 * 按 playthroughId 绑定 —— 每个 GameSessionWrapper 实例化时调一次。
 */

import { randomUUID } from 'node:crypto';
import type { MemoryDeletionFilter } from '@ivn/core/memory/types';
import type { RetrievalLogger } from '@ivn/core/memory/retrieval-logger';
import type { CoreEventSink, CoreEvent } from '@ivn/core/game-session';
import { memoryAnnotationService } from '#internal/services/memory-annotation-service';
import { memoryRetrievalService } from '#internal/services/memory-retrieval-service';

/**
 * Memory.retrieve 的 deletionFilter —— 拉当前 active 标注的 entry id set。
 *
 * 性能：每次 retrieve 都查一次 DB（典型 < 几十行）。失败抛错被 adapter 视为
 * "退化为不过滤"，不阻塞主路径。
 *
 * 当前不缓存：playthrough 内 retrieve 频率每轮 1-3 次，annotations 表又小，
 * SQL 成本可忽略。Step 2 如果观测到 hot path，再加 in-memory cache。
 */
export function createMemoryDeletionFilter(playthroughId: string): MemoryDeletionFilter {
  return {
    async listDeleted() {
      const rows = await memoryAnnotationService.listActiveByPlaythrough(playthroughId);
      return new Set(rows.map((r) => r.memoryEntryId));
    },
  };
}

/**
 * Memory.retrieve 的 logger —— 落 turn_memory_retrievals 表 + emit core event。
 *
 * fire-and-forget 契约：失败只 log warn，不抛回 wrapper（wrapper 已经 catch）。
 *
 * core event 让客户端实时拿到 retrieval 数据（用 MemoryPanel 显示）；DB 表
 * 让重连 / 历史回看可拿到。两路独立。
 */
export interface CreateRetrievalLoggerOptions {
  playthroughId: string;
  /** 可选：emit 'memory-retrieval' core event。无 sink 时只落 DB。*/
  coreEventSink?: CoreEventSink | undefined;
}

export function createMemoryRetrievalLogger(
  options: CreateRetrievalLoggerOptions,
): RetrievalLogger {
  return async (ctx, result) => {
    const id = randomUUID();
    const entries = (result.entries ?? []).map((e) => ({
      id: e.id,
      turn: e.turn,
      role: e.role,
      content: e.content,
      tokenCount: e.tokenCount,
      timestamp: e.timestamp,
      ...(e.tags ? { tags: e.tags } : {}),
      ...(e.pinned !== undefined ? { pinned: e.pinned } : {}),
    }));

    // 1. 落库
    try {
      await memoryRetrievalService.record({
        id,
        playthroughId: options.playthroughId,
        turn: ctx.turn,
        batchId: ctx.batchId,
        source: ctx.source,
        query: ctx.query,
        entries,
        summary: result.summary,
        meta: result.meta ?? null,
      });
    } catch (err) {
      console.warn('[memory-retrieval-logger] persist failed:', err);
      // 不 emit 客户端事件 —— 客户端拿到 retrievalId 但 DB 没有，后续 mark
      // 会 NOT_FOUND
      return;
    }

    // 2. emit core event 给客户端实时更新 MemoryPanel
    if (options.coreEventSink) {
      const event: CoreEvent = {
        type: 'memory-retrieval',
        retrievalId: id,
        turn: ctx.turn,
        source: ctx.source,
        query: ctx.query,
        entries,
        summary: result.summary,
      };
      try {
        await options.coreEventSink.publish(event);
      } catch (err) {
        console.warn('[memory-retrieval-logger] coreEventSink.publish failed:', err);
      }
    }
  };
}
