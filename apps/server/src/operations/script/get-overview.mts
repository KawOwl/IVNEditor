/**
 * script.get_overview —— 取剧本结构大纲（chapters + segments 摘要）
 *
 * 让 agent 在不拉完整 manifest 的前提下决定要改哪个 segment。
 * 默认取剧本当前最新的版本（published 优先，fallback 最新 draft）。
 */

import { z } from 'zod/v4';

import { defineOp } from '#internal/operations/op-kit';
import { OpError } from '#internal/operations/errors';
import { scriptService } from '#internal/services/script-service';
import { resolveTargetVersion } from '#internal/operations/script/_shared';

export const getOverviewInput = z.object({
  scriptId: z.string().describe('剧本 id'),
  versionId: z
    .string()
    .optional()
    .describe('可选：指定版本 id；不传则取 published，无 published 则取最新 draft'),
}).strict();

const stateVarSchema = z.object({
  name: z.string(),
  type: z.enum(['number', 'string', 'boolean', 'array', 'object']),
  initial: z.unknown(),
  description: z.string(),
});

const segmentPreviewSchema = z.object({
  segmentId: z.string(),
  label: z.string(),
  type: z.string(),
  role: z.string(),
  priority: z.number(),
  tokenCount: z.number(),
  preview: z.string(),
});

const chapterOverviewSchema = z.object({
  chapterId: z.string(),
  chapterLabel: z.string(),
  segmentCount: z.number().int().nonnegative(),
  segments: z.array(segmentPreviewSchema),
});

export const getOverviewOutput = z.object({
  scriptId: z.string(),
  scriptLabel: z.string(),
  scriptDescription: z.string().nullable(),
  versionId: z.string(),
  versionNumber: z.number().int(),
  versionStatus: z.enum(['draft', 'published', 'archived']),
  manifestLabel: z.string(),
  manifestDescription: z.string().optional(),
  tags: z.array(z.string()),
  author: z.string().optional(),
  stateVariables: z.array(stateVarSchema),
  chapters: z.array(chapterOverviewSchema),
});

export const getOverviewOp = defineOp({
  name: 'script.get_overview',
  description:
    '取剧本的"结构大纲"：label / description / chapters 列表 + 每章 segments 的 id/label/type/role/' +
    'priority/前 120 字预览。目的是让 AI 能在不拉完整 manifest 的前提下决定要改哪个 segment。' +
    '默认取剧本当前最新的版本（published 优先，fallback 到最新 draft）。',
  category: 'script',
  effect: 'safe',
  auth: 'admin',
  uiLabel: '剧本大纲',
  mcpName: 'get_script_overview', // backward compat
  input: getOverviewInput,
  output: getOverviewOutput,
  async exec({ scriptId, versionId }) {
    const script = await scriptService.getById(scriptId);
    if (!script) throw new OpError('NOT_FOUND', `Script not found: ${scriptId}`);

    const version = await resolveTargetVersion(scriptId, versionId);
    const m = version.manifest;
    return {
      scriptId,
      scriptLabel: script.label,
      scriptDescription: script.description,
      versionId: version.id,
      versionNumber: version.versionNumber,
      versionStatus: version.status,
      manifestLabel: m.label,
      manifestDescription: m.description,
      tags: m.tags ?? [],
      author: m.author,
      stateVariables: m.stateSchema.variables.map((v) => ({
        name: v.name,
        type: v.type,
        initial: v.initial,
        description: v.description,
      })),
      chapters: m.chapters.map((c) => ({
        chapterId: c.id,
        chapterLabel: c.label,
        segmentCount: c.segments.length,
        segments: c.segments.map((s) => ({
          segmentId: s.id,
          label: s.label,
          type: s.type,
          role: s.role,
          priority: s.priority,
          tokenCount: s.tokenCount,
          preview: s.content.slice(0, 120) + (s.content.length > 120 ? '…' : ''),
        })),
      })),
    };
  },
});
