/**
 * memory.mark_deleted —— 标记某条 memory entry 为"忘掉"
 *
 * 玩家点击 MemoryPanel 中的 entry → 选 reason → 触发该 op。
 * 写入 memory_deletion_annotations 一行（含 entry 内容快照）。
 * D1=B：下一轮 retrieve 会过滤掉已标 entry。
 *
 * Idempotent：同一 entry 重复标记返回原 annotation（reason 不更新）。
 */

import { z } from 'zod/v4';

import { defineOp } from '#internal/operations/op-kit';
import { OpError } from '#internal/operations/errors';
import {
  memoryAnnotationService,
  REASON_CODES,
  RetrievalEntryNotFoundError,
} from '#internal/services/memory-annotation-service';
import { memoryRetrievalService } from '#internal/services/memory-retrieval-service';
import { playthroughService } from '#internal/services/playthrough-service';

export const markDeletedInput = z.object({
  /** 来自 list_turn_retrievals 的 retrievals[].id */
  turnMemoryRetrievalId: z.string(),
  /** 来自 retrievals[].entries[].id */
  memoryEntryId: z.string(),
  reasonCode: z.enum(REASON_CODES),
  /** reason_code='other' 时玩家可填的简短自由文本 */
  reasonText: z.string().max(500).optional(),
}).strict();

export const markDeletedOutput = z.object({
  annotationId: z.string(),
  memoryEntryId: z.string(),
  reasonCode: z.enum(REASON_CODES),
  createdAt: z.string(),
});

export const markDeletedOp = defineOp({
  name: 'memory.mark_deleted',
  description:
    '标记某条 memory entry 为"忘掉"（数据回流标注）。下一轮 retrieve 会跳过' +
    '该 entry。idempotent：同一 entry 重复标记返回原 annotation。',
  category: 'memory',
  effect: 'mutating',
  auth: 'any',
  uiLabel: '标记忘掉',
  input: markDeletedInput,
  output: markDeletedOutput,
  async exec({ turnMemoryRetrievalId, memoryEntryId, reasonCode, reasonText }, ctx) {
    // 鉴权：retrieval 关联的 playthrough 必须属于当前 user（admin 例外）
    const retrieval = await memoryRetrievalService.getById(turnMemoryRetrievalId);
    if (!retrieval) {
      throw new OpError('NOT_FOUND', `Retrieval not found: ${turnMemoryRetrievalId}`);
    }
    const ownerId = await playthroughService.getOwnerId(retrieval.playthroughId);
    if (ownerId === null) {
      throw new OpError('NOT_FOUND', `Playthrough not found: ${retrieval.playthroughId}`);
    }
    if (ctx.kind !== 'admin' && ownerId !== ctx.userId) {
      throw new OpError('FORBIDDEN', `Playthrough not owned by current user`);
    }

    try {
      const ann = await memoryAnnotationService.markDeleted({
        turnMemoryRetrievalId,
        memoryEntryId,
        reasonCode,
        reasonText,
      });
      return {
        annotationId: ann.id,
        memoryEntryId: ann.memoryEntryId,
        reasonCode: ann.reasonCode,
        createdAt: ann.createdAt.toISOString(),
      };
    } catch (err) {
      if (err instanceof RetrievalEntryNotFoundError) {
        throw new OpError(
          'INVALID_INPUT',
          `Memory entry "${memoryEntryId}" not in retrieval "${turnMemoryRetrievalId}"`,
          { cause: err },
        );
      }
      throw err;
    }
  },
});
