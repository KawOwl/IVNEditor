/**
 * memory.cancel_deletion —— 在 5s 撤销窗内取消标注
 *
 * 玩家点击 toast 上的"撤销"按钮触发。超过 5s 报 CONFLICT。
 */

import { z } from 'zod/v4';

import { defineOp } from '#internal/operations/op-kit';
import { OpError } from '#internal/operations/errors';
import {
  memoryAnnotationService,
  CancelWindowExpiredError,
  AnnotationNotFoundError,
} from '#internal/services/memory-annotation-service';
import { playthroughService } from '#internal/services/playthrough-service';

export const cancelDeletionInput = z.object({
  annotationId: z.string(),
}).strict();

export const cancelDeletionOutput = z.object({
  annotationId: z.string(),
  cancelledAt: z.string(),
});

export const cancelDeletionOp = defineOp({
  name: 'memory.cancel_deletion',
  description: '撤销一条 memory 删除标注（仅在 5s 撤销窗内有效）。',
  category: 'memory',
  effect: 'mutating',
  auth: 'any',
  uiLabel: '撤销忘掉',
  input: cancelDeletionInput,
  output: cancelDeletionOutput,
  async exec({ annotationId }, ctx) {
    // 鉴权：先取出 annotation 的 playthroughId 验证 ownership（admin 例外）
    const ann = await memoryAnnotationService.getById(annotationId);
    if (!ann) {
      throw new OpError('NOT_FOUND', `Annotation not found: ${annotationId}`);
    }
    const ownerId = await playthroughService.getOwnerId(ann.playthroughId);
    if (ownerId === null) {
      throw new OpError('NOT_FOUND', `Playthrough not found: ${ann.playthroughId}`);
    }
    if (ctx.kind !== 'admin' && ownerId !== ctx.userId) {
      throw new OpError('FORBIDDEN', `Annotation not owned by current user`);
    }

    try {
      const updated = await memoryAnnotationService.cancel(annotationId);
      return {
        annotationId: updated.id,
        cancelledAt: updated.cancelledAt!.toISOString(),
      };
    } catch (err) {
      if (err instanceof CancelWindowExpiredError) {
        throw new OpError(
          'CONFLICT',
          `Cancel window expired (${err.elapsedMs}ms > 5000ms)`,
          { cause: err },
        );
      }
      if (err instanceof AnnotationNotFoundError) {
        throw new OpError('NOT_FOUND', `Annotation not found or already cancelled: ${annotationId}`, { cause: err });
      }
      throw err;
    }
  },
});
