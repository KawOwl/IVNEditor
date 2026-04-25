/**
 * script.add_background —— 【高阶】上传背景图 + 加到 manifest.backgrounds[] + 建新 draft
 *
 * 一站式。如果 backgroundId 已存在，用新图覆盖（assetUrl / label 更新）。
 * 不自动 publish。这是修复 trace bg-unknown-scene 类问题的常用入口
 * （配合 lint_manifest 找出哪些 background 缺失）。
 */

import { z } from 'zod/v4';

import { defineOp } from '#internal/operations/op-kit';
import { OpError } from '#internal/operations/errors';
import { scriptVersionService } from '#internal/services/script-version-service';
import {
  cloneManifest,
  getBaselineVersion,
} from '#internal/operations/script/_shared';
import {
  backgroundResultNote,
  backgroundVersionNote,
  uploadImageBytes,
  upsertBackgroundAsset,
} from '#internal/operations/script/_asset-helpers';

export const addBackgroundInput = z.object({
  scriptId: z.string(),
  backgroundId: z
    .string()
    .describe('snake_case 背景 id，会被 LLM 在 change_scene / <background scene="..."> 里引用。例：classroom_evening'),
  label: z.string().optional().describe('可选：人读描述，如 "教室·黄昏"'),
  contentType: z.string().describe('image/png / image/jpeg / 等'),
  imageBase64: z.string().describe('base64 或 data URL'),
  versionLabel: z.string().optional(),
  versionNote: z.string().optional(),
}).strict();

export const addBackgroundOutput = z.object({
  scriptId: z.string(),
  backgroundId: z.string(),
  assetUrl: z.string(),
  assetId: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  replaced: z.boolean(),
  baseVersionId: z.string(),
  newVersionId: z.string(),
  newVersionNumber: z.number().int(),
  note: z.string(),
});

export const addBackgroundOp = defineOp({
  name: 'script.add_background',
  description:
    '【高阶】上传一张背景图 + 把它作为 BackgroundAsset 加到 manifest.backgrounds[] + 建新 draft 版本。' +
    '如果 backgroundId 已存在，会用新图覆盖（assetUrl / label 更新）。' +
    '不自动 publish —— 需要编剧复核后再调 publish_script_version。',
  category: 'script',
  effect: 'mutating',
  auth: 'admin',
  uiLabel: '加背景（高阶）',
  mcpName: 'add_background_to_script', // backward compat
  input: addBackgroundInput,
  output: addBackgroundOutput,
  async exec(input, ctx) {
    if (!ctx.userId) {
      throw new OpError('UNAUTHORIZED', 'add_background requires authenticated user');
    }
    const base = await getBaselineVersion(input.scriptId);
    const manifest = cloneManifest(base.manifest);

    const asset = await uploadImageBytes({
      scriptId: input.scriptId,
      kind: 'background',
      contentType: input.contentType,
      imageBase64: input.imageBase64,
      originalName: input.label,
      uploadedByUserId: ctx.userId,
    });

    const upsert = upsertBackgroundAsset(
      manifest.backgrounds ?? [],
      input.backgroundId,
      asset.assetUrl,
      input.label,
    );
    manifest.backgrounds = upsert.backgrounds;

    const result = await scriptVersionService.create({
      scriptId: input.scriptId,
      manifest,
      label: input.versionLabel,
      note: input.versionNote ?? backgroundVersionNote(input.backgroundId, upsert.replaced),
      status: 'draft',
    });

    return {
      scriptId: input.scriptId,
      backgroundId: input.backgroundId,
      assetUrl: asset.assetUrl,
      assetId: asset.assetId,
      sizeBytes: asset.sizeBytes,
      replaced: upsert.replaced,
      baseVersionId: base.id,
      newVersionId: result.version.id,
      newVersionNumber: result.version.versionNumber,
      note: backgroundResultNote(upsert.replaced),
    };
  },
});
