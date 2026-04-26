/**
 * MemoryAnnotationService — `memory_deletion_annotations` 表 CRUD（ANN.1）
 *
 * 玩家通过 op `memory.mark_deleted` / `memory.cancel_deletion` 操作；
 * Memory adapter 通过 listActiveByPlaythrough 拿 tombstone set 做 retrieve filter。
 *
 * 撤销窗：5s。超过则 cancel 报 OUT_OF_WINDOW。
 *
 * unique 约束（partial index uniq_memory_deletion_active）：
 *   同一 (playthrough, memory_entry_id) 只能有一条 active 标注；
 *   撤销后允许再次标记。
 */

import { eq, and, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db, schema } from '#internal/db';
import type { MemoryEntrySnapshot } from '#internal/db/schema';

export const REASON_CODES = [
  'character-broken',
  'memory-confused',
  'logic-error',
  'other',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** 5 秒撤销窗 */
export const CANCEL_WINDOW_MS = 5_000;

export interface MemoryDeletionAnnotationRow {
  id: string;
  turnMemoryRetrievalId: string;
  playthroughId: string;
  memoryEntryId: string;
  memoryEntrySnapshot: MemoryEntrySnapshot;
  reasonCode: ReasonCode;
  reasonText: string | null;
  createdAt: Date;
  cancelledAt: Date | null;
}

export interface MarkDeletedInput {
  turnMemoryRetrievalId: string;
  memoryEntryId: string;
  reasonCode: ReasonCode;
  reasonText?: string | null;
}

export interface ActiveDeletion {
  memoryEntryId: string;
  reasonCode: ReasonCode;
  annotationId: string;
}

// ============================================================================
// Service errors
// ============================================================================

/** 5s 撤销窗外尝试取消 */
export class CancelWindowExpiredError extends Error {
  constructor(public readonly annotationId: string, public readonly elapsedMs: number) {
    super(
      `[memory-annotation-service] cancel window expired for ${annotationId} (elapsed ${elapsedMs}ms > ${CANCEL_WINDOW_MS}ms)`,
    );
    this.name = 'CancelWindowExpiredError';
  }
}

/** retrievalId 不存在 / entry 不在该 retrieval 的 entries 里 */
export class RetrievalEntryNotFoundError extends Error {
  constructor(public readonly retrievalId: string, public readonly memoryEntryId: string) {
    super(
      `[memory-annotation-service] retrievalId="${retrievalId}" entry="${memoryEntryId}" not found in retrieval entries`,
    );
    this.name = 'RetrievalEntryNotFoundError';
  }
}

/** annotation 不存在 / 已经撤销 */
export class AnnotationNotFoundError extends Error {
  constructor(public readonly annotationId: string) {
    super(`[memory-annotation-service] annotation not found or already cancelled: ${annotationId}`);
    this.name = 'AnnotationNotFoundError';
  }
}

// ============================================================================
// Service
// ============================================================================

class MemoryAnnotationService {
  /**
   * 标记某条 memory entry 为"忘掉"。
   *
   * 校验：
   *   - retrievalId 必须存在
   *   - memoryEntryId 必须在该 retrieval 的 entries 里（防止前端传错 id）
   *
   * unique 约束在 DB 层（partial unique index）：同一 entry 已 active 标注则
   * insert 抛 unique violation —— caller 视为 idempotent 成功（找出已有 row 返回）。
   */
  async markDeleted(input: MarkDeletedInput): Promise<MemoryDeletionAnnotationRow> {
    // 1. 校验 retrieval 存在 + entry 在 entries 里
    const retrievalRows = await db
      .select()
      .from(schema.turnMemoryRetrievals)
      .where(eq(schema.turnMemoryRetrievals.id, input.turnMemoryRetrievalId))
      .limit(1);
    const retrieval = retrievalRows[0];
    if (!retrieval) {
      throw new RetrievalEntryNotFoundError(input.turnMemoryRetrievalId, input.memoryEntryId);
    }
    const entry = (retrieval.entries as MemoryEntrySnapshot[]).find(
      (e) => e.id === input.memoryEntryId,
    );
    if (!entry) {
      throw new RetrievalEntryNotFoundError(input.turnMemoryRetrievalId, input.memoryEntryId);
    }

    // 2. 检查是否已存在 active 标注（idempotent）
    const existing = await this.findActive(retrieval.playthroughId, input.memoryEntryId);
    if (existing) {
      return existing;
    }

    // 3. insert
    const id = randomUUID();
    await db.insert(schema.memoryDeletionAnnotations).values({
      id,
      turnMemoryRetrievalId: input.turnMemoryRetrievalId,
      playthroughId: retrieval.playthroughId,
      memoryEntryId: input.memoryEntryId,
      memoryEntrySnapshot: entry,
      reasonCode: input.reasonCode,
      reasonText: input.reasonText ?? null,
    });

    const row = await this.getById(id);
    if (!row) {
      throw new Error(`[memory-annotation-service.markDeleted] insert succeeded but row not found: ${id}`);
    }
    return row;
  }

  /**
   * 5s 撤销窗内取消标注。
   *   - 找不到 active annotation → AnnotationNotFoundError
   *   - 超过 5s → CancelWindowExpiredError
   */
  async cancel(annotationId: string, now: Date = new Date()): Promise<MemoryDeletionAnnotationRow> {
    const row = await this.getById(annotationId);
    if (!row || row.cancelledAt !== null) {
      throw new AnnotationNotFoundError(annotationId);
    }
    const elapsed = now.getTime() - row.createdAt.getTime();
    if (elapsed > CANCEL_WINDOW_MS) {
      throw new CancelWindowExpiredError(annotationId, elapsed);
    }

    await db
      .update(schema.memoryDeletionAnnotations)
      .set({ cancelledAt: now })
      .where(eq(schema.memoryDeletionAnnotations.id, annotationId));

    const updated = await this.getById(annotationId);
    if (!updated) {
      throw new Error(`[memory-annotation-service.cancel] row disappeared after update: ${annotationId}`);
    }
    return updated;
  }

  async getById(id: string): Promise<MemoryDeletionAnnotationRow | null> {
    const rows = await db
      .select()
      .from(schema.memoryDeletionAnnotations)
      .where(eq(schema.memoryDeletionAnnotations.id, id))
      .limit(1);
    return (rows[0] as MemoryDeletionAnnotationRow) ?? null;
  }

  /**
   * Memory adapter retrieve filter 用。
   * 返回所有 active（cancelled_at IS NULL）标注的 entry id + reason。
   */
  async listActiveByPlaythrough(playthroughId: string): Promise<ActiveDeletion[]> {
    const rows = await db
      .select({
        id: schema.memoryDeletionAnnotations.id,
        memoryEntryId: schema.memoryDeletionAnnotations.memoryEntryId,
        reasonCode: schema.memoryDeletionAnnotations.reasonCode,
      })
      .from(schema.memoryDeletionAnnotations)
      .where(
        and(
          eq(schema.memoryDeletionAnnotations.playthroughId, playthroughId),
          isNull(schema.memoryDeletionAnnotations.cancelledAt),
        ),
      );
    return rows.map((r) => ({
      annotationId: r.id,
      memoryEntryId: r.memoryEntryId,
      reasonCode: r.reasonCode as ReasonCode,
    }));
  }

  /**
   * 列某 playthrough 全部标注（含已撤销），按 created_at 降序。
   * 调试 + 数据导出用。
   */
  async listAllByPlaythrough(playthroughId: string): Promise<MemoryDeletionAnnotationRow[]> {
    const rows = await db
      .select()
      .from(schema.memoryDeletionAnnotations)
      .where(eq(schema.memoryDeletionAnnotations.playthroughId, playthroughId));
    return rows as MemoryDeletionAnnotationRow[];
  }

  // ─── Internal ────────────────────────────────────────────────────────

  private async findActive(
    playthroughId: string,
    memoryEntryId: string,
  ): Promise<MemoryDeletionAnnotationRow | null> {
    const rows = await db
      .select()
      .from(schema.memoryDeletionAnnotations)
      .where(
        and(
          eq(schema.memoryDeletionAnnotations.playthroughId, playthroughId),
          eq(schema.memoryDeletionAnnotations.memoryEntryId, memoryEntryId),
          isNull(schema.memoryDeletionAnnotations.cancelledAt),
        ),
      )
      .limit(1);
    return (rows[0] as MemoryDeletionAnnotationRow) ?? null;
  }
}

export const memoryAnnotationService = new MemoryAnnotationService();
