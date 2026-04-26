/**
 * MemoryRetrievalService — `turn_memory_retrievals` 表 CRUD（ANN.1）
 *
 * 每次 Memory.retrieve() 在 retrieval-logger 包装层落一行。
 * MemoryPanel 通过 op `memory.list_turn_retrievals` 读出展示给玩家。
 *
 * 不做：去重 / 合并 / 跨 turn 聚合 —— 那是消费侧的事。
 */

import { eq, and, desc } from 'drizzle-orm';
import { db, schema } from '#internal/db';
import type { MemoryEntrySnapshot } from '#internal/db/schema';

export type RetrievalSource = 'context-assembly' | 'tool-call';

export interface TurnMemoryRetrievalRow {
  id: string;
  playthroughId: string;
  turn: number;
  batchId: string | null;
  source: RetrievalSource;
  query: string;
  entries: MemoryEntrySnapshot[];
  summary: string;
  meta: Record<string, unknown> | null;
  retrievedAt: Date;
}

export interface RecordRetrievalInput {
  id: string;
  playthroughId: string;
  turn: number;
  batchId: string | null;
  source: RetrievalSource;
  query: string;
  entries: MemoryEntrySnapshot[];
  summary: string;
  meta?: Record<string, unknown> | null;
}

class MemoryRetrievalService {
  async record(input: RecordRetrievalInput): Promise<TurnMemoryRetrievalRow> {
    await db.insert(schema.turnMemoryRetrievals).values({
      id: input.id,
      playthroughId: input.playthroughId,
      turn: input.turn,
      batchId: input.batchId,
      source: input.source,
      query: input.query,
      entries: input.entries,
      summary: input.summary,
      meta: input.meta ?? null,
    });
    const row = await this.getById(input.id);
    if (!row) {
      throw new Error(
        `[memory-retrieval-service.record] failed to fetch row after insert: ${input.id}`,
      );
    }
    return row;
  }

  async getById(id: string): Promise<TurnMemoryRetrievalRow | null> {
    const rows = await db
      .select()
      .from(schema.turnMemoryRetrievals)
      .where(eq(schema.turnMemoryRetrievals.id, id))
      .limit(1);
    return (rows[0] as TurnMemoryRetrievalRow) ?? null;
  }

  /**
   * 列某 playthrough 的 retrieval。默认按 retrieved_at desc，limit 50。
   * 可选过滤特定 turn。
   */
  async listByPlaythrough(
    playthroughId: string,
    opts: { turn?: number; limit?: number } = {},
  ): Promise<TurnMemoryRetrievalRow[]> {
    const limit = opts.limit ?? 50;
    const conditions =
      opts.turn !== undefined
        ? and(
            eq(schema.turnMemoryRetrievals.playthroughId, playthroughId),
            eq(schema.turnMemoryRetrievals.turn, opts.turn),
          )
        : eq(schema.turnMemoryRetrievals.playthroughId, playthroughId);

    const rows = await db
      .select()
      .from(schema.turnMemoryRetrievals)
      .where(conditions)
      .orderBy(desc(schema.turnMemoryRetrievals.retrievedAt))
      .limit(limit);

    return rows as TurnMemoryRetrievalRow[];
  }
}

export const memoryRetrievalService = new MemoryRetrievalService();
