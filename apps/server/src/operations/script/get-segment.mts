/**
 * script.get_segment —— 取单个 segment 的完整内容
 *
 * 包含原文 content + 可能存在的 derivedContent（LLM 改写版本）+ 全部
 * 元数据。get_overview 给的是预览，要看全文走这个。
 */

import { z } from 'zod/v4';

import { defineOp } from '#internal/operations/op-kit';
import { OpError } from '#internal/operations/errors';
import { findSegment, resolveTargetVersion } from '#internal/operations/script/_shared';

export const getSegmentInput = z.object({
  scriptId: z.string(),
  chapterId: z.string(),
  segmentId: z.string(),
  versionId: z
    .string()
    .optional()
    .describe('可选：指定版本；不传则取当前最新（published 优先）'),
}).strict();

// segment 形状直接透出 PromptSegment（z.unknown 兜底，因为 PromptSegment 的
// derivedContent / focusTags / injectionRule 等可选字段太多，写完整 zod
// schema 维护成本不值；调用方按 @ivn/core 的 PromptSegment type 类型即可）。
export const getSegmentOutput = z.object({
  scriptId: z.string(),
  versionId: z.string(),
  chapterId: z.string(),
  segment: z.unknown(),
});

export const getSegmentOp = defineOp({
  name: 'script.get_segment',
  description: '取单个 segment 的完整内容（原文 + 可能存在的 derivedContent 改写版本）。',
  category: 'script',
  effect: 'safe',
  auth: 'admin',
  uiLabel: '取段落全文',
  input: getSegmentInput,
  output: getSegmentOutput,
  async exec({ scriptId, chapterId, segmentId, versionId }) {
    const version = await resolveTargetVersion(scriptId, versionId);
    const hit = findSegment(version.manifest, chapterId, segmentId);
    if (!hit) throw new OpError('NOT_FOUND', `Segment not found: ${chapterId}/${segmentId}`);
    return {
      scriptId,
      versionId: version.id,
      chapterId,
      segment: hit.segment,
    };
  },
});
