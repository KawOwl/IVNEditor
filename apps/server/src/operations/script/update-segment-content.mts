/**
 * script.update_segment_content —— 修改单个 segment 正文，建新 draft
 *
 * 以"最新版本"作基线（published 优先，fallback 最新 draft），打包成新
 * draft 版本（不自动 publish）。后续 publish 走 script.publish_version。
 *
 * 写入的"原文"会清掉旧的 derivedContent，避免后续玩家读到老的 LLM 改写。
 * Hash 去重：内容与基线完全一致时不新建版本。
 */

import { z } from 'zod/v4';

import { rehashSegment } from '@ivn/core/architect/prompt-splitter';
import { estimateTokens } from '@ivn/core/tokens';
import type { PromptSegment } from '@ivn/core/types';

import { defineOp } from '#internal/operations/op-kit';
import { OpError } from '#internal/operations/errors';
import { scriptVersionService } from '#internal/services/script-version-service';
import {
  cloneManifest,
  findSegment,
  getBaselineVersion,
} from '#internal/operations/script/_shared';

export const updateSegmentContentInput = z.object({
  scriptId: z.string(),
  chapterId: z.string(),
  segmentId: z.string(),
  newContent: z.string().describe('替换后的 segment.content 完整原文'),
  versionLabel: z.string().optional().describe('可选：给新 draft 版本起个名字，方便在版本列表里辨认'),
  versionNote: z.string().optional().describe('可选：改动说明（提交信息），存在 script_versions.note 里'),
}).strict();

export const updateSegmentContentOutput = z.object({
  scriptId: z.string(),
  baseVersionId: z.string(),
  baseVersionNumber: z.number().int(),
  newVersionId: z.string(),
  newVersionNumber: z.number().int(),
  created: z.boolean(),
  segment: z.object({
    chapterId: z.string(),
    segmentId: z.string(),
    oldContentLength: z.number().int(),
    newContentLength: z.number().int(),
    oldTokenCount: z.number().int(),
    newTokenCount: z.number().int(),
  }),
  note: z.string(),
});

export const updateSegmentContentOp = defineOp({
  name: 'script.update_segment_content',
  description:
    '修改单个 segment 的正文。会以"最新版本"（published 优先，否则最新 draft）为基线，' +
    '把改动打包成一个**新的 draft 版本**（不自动发布）。返回新建的 versionId。' +
    '如果要让玩家看到，编剧或 AI 需要再调 publish_script_version。',
  category: 'script',
  effect: 'mutating',
  auth: 'admin',
  uiLabel: '改写段落正文',
  input: updateSegmentContentInput,
  output: updateSegmentContentOutput,
  async exec(input) {
    const { scriptId, chapterId, segmentId, newContent, versionLabel, versionNote } = input;

    const base = await getBaselineVersion(scriptId);

    const manifest = cloneManifest(base.manifest);
    const hit = findSegment(manifest, chapterId, segmentId);
    if (!hit) {
      throw new OpError('NOT_FOUND', `Segment not found: ${chapterId}/${segmentId}`);
    }

    const prev = hit.segment;
    const updated: PromptSegment = rehashSegment({
      ...prev,
      content: newContent,
      tokenCount: estimateTokens(newContent),
      // 新原文替换了旧 derived（保持一致性）
      derivedContent: undefined,
      useDerived: false,
    });
    manifest.chapters[hit.chapterIdx]!.segments[hit.segmentIdx] = updated;

    const result = await scriptVersionService.create({
      scriptId,
      manifest,
      label: versionLabel,
      note: versionNote ?? `mcp: update segment ${chapterId}/${segmentId}`,
      status: 'draft',
    });
    return {
      scriptId,
      baseVersionId: base.id,
      baseVersionNumber: base.versionNumber,
      newVersionId: result.version.id,
      newVersionNumber: result.version.versionNumber,
      created: result.created,
      segment: {
        chapterId,
        segmentId,
        oldContentLength: prev.content.length,
        newContentLength: newContent.length,
        oldTokenCount: prev.tokenCount,
        newTokenCount: updated.tokenCount,
      },
      note: result.created
        ? '已生成新 draft 版本。预览 / 发布前请用 list_script_versions 或 get_script_overview 复核，然后 publish_script_version 发布。'
        : '提交内容与最新版本完全一致，未新建版本（hash 去重）。',
    };
  },
});
