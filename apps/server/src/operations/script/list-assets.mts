/**
 * script.list_assets —— 列出某剧本已上传的所有图片资产
 *
 * 用途：
 *  - AI 上传新图前查有没有可复用的（避免重复上传）
 *  - 编剧让 AI "列一下我已经传了哪些图"
 *  - lint / propose-alignment 类 op 看 manifest 引用 vs 实际资产对照
 */

import { z } from 'zod/v4';

import { defineOp } from '#internal/operations/op-kit';
import { OpError } from '#internal/operations/errors';
import { scriptService } from '#internal/services/script-service';
import { assetService } from '#internal/services/asset-service';

export const listAssetsInput = z.object({
  scriptId: z.string(),
}).strict();

const assetSchema = z.object({
  assetId: z.string(),
  kind: z.enum(['sprite', 'background']),
  storageKey: z.string(),
  assetUrl: z.string(),
  originalName: z.string().nullable(),
  contentType: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
});

export const listAssetsOutput = z.object({
  scriptId: z.string(),
  assets: z.array(assetSchema),
});

export const listAssetsOp = defineOp({
  name: 'script.list_assets',
  description:
    '列出某剧本已上传的所有图片资产（立绘 / 背景）。返回每条的 assetId / storageKey / assetUrl / kind。' +
    '用于：AI 上传新图前查有没有可复用的；或者编剧让 AI "列一下我已经传了哪些图"。',
  category: 'script',
  effect: 'safe',
  auth: 'admin',
  uiLabel: '列出资产',
  mcpName: 'list_script_assets', // backward compat
  input: listAssetsInput,
  output: listAssetsOutput,
  async exec({ scriptId }) {
    const owner = await scriptService.getOwnerId(scriptId);
    if (!owner) throw new OpError('NOT_FOUND', `Script not found: ${scriptId}`);
    const assets = await assetService.listByScript(scriptId);
    return {
      scriptId,
      assets: assets.map((a) => ({
        assetId: a.id,
        kind: a.kind,
        storageKey: a.storageKey,
        assetUrl: `/api/assets/${a.storageKey}`,
        originalName: a.originalName,
        contentType: a.contentType,
        sizeBytes: a.sizeBytes,
        createdAt: a.createdAt.toISOString(),
      })),
    };
  },
});
