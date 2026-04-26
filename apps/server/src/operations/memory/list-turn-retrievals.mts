/**
 * memory.list_turn_retrievals —— 列某 playthrough 的 retrieval 历史
 *
 * MemoryPanel 用：玩家进入 playthrough 时拉历史 retrieval，把"本 turn 的
 * memory 列表"渲染出来。
 *
 * auth='any'：anonymous 玩家也能看自己的 retrieval（playthrough 已经按 user
 * 隔离）。
 */

import { z } from 'zod/v4';

import { defineOp } from '#internal/operations/op-kit';
import { OpError } from '#internal/operations/errors';
import { memoryRetrievalService } from '#internal/services/memory-retrieval-service';
import { memoryAnnotationService } from '#internal/services/memory-annotation-service';
import { playthroughService } from '#internal/services/playthrough-service';

const memoryEntrySchema = z.object({
  id: z.string(),
  turn: z.number(),
  role: z.enum(['generate', 'receive', 'system']),
  content: z.string(),
  tokenCount: z.number(),
  timestamp: z.number(),
  tags: z.array(z.string()).optional(),
  pinned: z.boolean().optional(),
});

const retrievalSchema = z.object({
  id: z.string(),
  turn: z.number(),
  batchId: z.string().nullable(),
  source: z.enum(['context-assembly', 'tool-call']),
  query: z.string(),
  entries: z.array(memoryEntrySchema),
  summary: z.string(),
  retrievedAt: z.string(),
});

const annotationSchema = z.object({
  annotationId: z.string(),
  memoryEntryId: z.string(),
  reasonCode: z.enum(['character-broken', 'memory-confused', 'logic-error', 'other']),
});

export const listTurnRetrievalsInput = z.object({
  playthroughId: z.string(),
  /** 可选：只拉某个 turn 的 retrieval；不传则拉最近 limit 条 */
  turn: z.number().int().optional(),
  /** 默认 50 */
  limit: z.number().int().min(1).max(200).optional(),
}).strict();

export const listTurnRetrievalsOutput = z.object({
  retrievals: z.array(retrievalSchema),
  /** 当前 active 的标注列表（玩家视角已"忘掉"的 memory entries）*/
  activeDeletions: z.array(annotationSchema),
});

export const listTurnRetrievalsOp = defineOp({
  name: 'memory.list_turn_retrievals',
  description:
    '列某 playthrough 的 retrieval 历史（每次 Memory.retrieve 的结果快照），' +
    '配套返回当前 active 的删除标注。MemoryPanel 用。',
  category: 'memory',
  effect: 'safe',
  auth: 'any',
  uiLabel: '列出本轮记忆',
  input: listTurnRetrievalsInput,
  output: listTurnRetrievalsOutput,
  async exec({ playthroughId, turn, limit }, ctx) {
    // 鉴权：playthrough 必须属于当前 user（admin 例外，可看任意 playthrough）
    const ownerId = await playthroughService.getOwnerId(playthroughId);
    if (ownerId === null) {
      throw new OpError('NOT_FOUND', `Playthrough not found: ${playthroughId}`);
    }
    if (ctx.kind !== 'admin' && ownerId !== ctx.userId) {
      throw new OpError('FORBIDDEN', `Playthrough ${playthroughId} not owned by current user`);
    }

    const rows = await memoryRetrievalService.listByPlaythrough(playthroughId, { turn, limit });
    const active = await memoryAnnotationService.listActiveByPlaythrough(playthroughId);

    return {
      retrievals: rows.map((row) => ({
        id: row.id,
        turn: row.turn,
        batchId: row.batchId,
        source: row.source,
        query: row.query,
        entries: row.entries,
        summary: row.summary,
        retrievedAt: row.retrievedAt.toISOString(),
      })),
      activeDeletions: active.map((d) => ({
        annotationId: d.annotationId,
        memoryEntryId: d.memoryEntryId,
        reasonCode: d.reasonCode,
      })),
    };
  },
});
