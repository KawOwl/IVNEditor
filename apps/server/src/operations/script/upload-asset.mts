/**
 * script.upload_asset —— 【低阶】上传一张图片到剧本资产库
 *
 * 只上传 + 记元数据，**不改 manifest**。返回 assetUrl，调用方后续可以
 * 自己塞进 manifest（用 replace_manifest）。日常使用更建议高阶 op
 * `script.add_background` / `script.add_character_sprite`，它们会一步
 * 做完"上传 + 挂到 manifest + 建新 draft"。
 */

import { z } from 'zod/v4';

import { defineOp } from '#internal/operations/op-kit';
import { OpError } from '#internal/operations/errors';
import { uploadImageBytes } from '#internal/operations/script/_asset-helpers';

export const uploadAssetInput = z.object({
  scriptId: z.string(),
  kind: z.enum(['sprite', 'background'])
    .describe('"sprite" = 角色立绘；"background" = 场景背景'),
  contentType: z.string().describe('MIME 类型，如 image/png / image/jpeg / image/webp'),
  imageBase64: z
    .string()
    .describe('图片原始字节的 base64 编码。支持 "data:image/png;base64,..." 前缀，也支持裸 base64。解码后最大 10 MB。'),
  originalName: z.string().optional().describe('可选：原始文件名（仅记 DB / 诊断用，不影响 URL）'),
}).strict();

export const uploadAssetOutput = z.object({
  assetId: z.string(),
  storageKey: z.string(),
  assetUrl: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string(),
  kind: z.enum(['sprite', 'background']),
});

export const uploadAssetOp = defineOp({
  name: 'script.upload_asset',
  description:
    '【低阶】把一张图片上传到剧本的资产库。只上传 + 记元数据，**不改 manifest**。' +
    '返回 assetUrl 可以自己后续塞进 manifest（用 replace_script_manifest）。' +
    '日常使用优先用高阶 tool add_background_to_script / add_character_sprite ——' +
    '它们会一步做完"上传 + 挂到 manifest + 建新 draft"。',
  category: 'script',
  effect: 'mutating',
  auth: 'admin',
  uiLabel: '上传资产（低阶）',
  mcpName: 'upload_script_asset', // backward compat
  input: uploadAssetInput,
  output: uploadAssetOutput,
  async exec(input, ctx) {
    if (!ctx.userId) {
      throw new OpError('UNAUTHORIZED', 'upload_asset requires authenticated user');
    }
    const asset = await uploadImageBytes({
      scriptId: input.scriptId,
      kind: input.kind,
      contentType: input.contentType,
      imageBase64: input.imageBase64,
      originalName: input.originalName,
      uploadedByUserId: ctx.userId,
    });
    return asset;
  },
});
