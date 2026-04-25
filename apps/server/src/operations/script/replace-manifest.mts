/**
 * script.replace_manifest —— 用完整 manifest JSON 覆盖剧本（建新 draft）
 *
 * 用于结构性修改（加章节 / 改 stateSchema / 调 memoryConfig 等）。传入的
 * manifest 必须是**完整的 ScriptManifest**，不是 partial patch。强烈建议
 * 先 get_full_manifest 拿基线，在它基础上改动后再调这个。
 *
 * 这层只做最少结构校验（chapters 是数组、stateSchema.variables 是数组、
 * memoryConfig 存在）。深度 zod validation 不做——真 validation 在
 * GameSession 跑起来那刻才有意义，提前做反而限制 schema 演进。
 */

import { z } from 'zod/v4';

import type { ScriptManifest } from '@ivn/core/types';

import { defineOp } from '#internal/operations/op-kit';
import { OpError } from '#internal/operations/errors';
import { scriptService } from '#internal/services/script-service';
import { scriptVersionService } from '#internal/services/script-version-service';

export const replaceManifestInput = z.object({
  scriptId: z.string(),
  manifest: z.unknown().describe('完整的 ScriptManifest JSON'),
  versionLabel: z.string().optional(),
  versionNote: z.string().optional(),
}).strict();

export const replaceManifestOutput = z.object({
  scriptId: z.string(),
  newVersionId: z.string(),
  newVersionNumber: z.number().int(),
  created: z.boolean(),
  note: z.string(),
});

export const replaceManifestOp = defineOp({
  name: 'script.replace_manifest',
  description:
    '用完整的 manifest JSON 覆盖剧本（创建新 draft 版本）。用于结构性修改（加章节 / 改 stateSchema / ' +
    '改 memoryConfig 等）。传入的 manifest 必须是**完整的 ScriptManifest**，不是 partial patch。' +
    '强烈建议：先用 get_full_manifest 拿到基线，在基础上改动后再调这个 tool，避免误删字段。',
  category: 'script',
  effect: 'mutating',
  auth: 'admin',
  uiLabel: '替换整个 manifest',
  mcpName: 'replace_script_manifest', // backward compat
  input: replaceManifestInput,
  output: replaceManifestOutput,
  async exec({ scriptId, manifest: rawManifest, versionLabel, versionNote }) {
    // 最少结构校验
    if (!rawManifest || typeof rawManifest !== 'object') {
      throw new OpError('INVALID_INPUT', 'manifest must be an object');
    }
    const manifest = rawManifest as ScriptManifest;
    if (!Array.isArray(manifest.chapters)) {
      throw new OpError('INVALID_INPUT', 'manifest.chapters must be an array');
    }
    if (!manifest.stateSchema || !Array.isArray(manifest.stateSchema.variables)) {
      throw new OpError('INVALID_INPUT', 'manifest.stateSchema.variables must be an array');
    }
    if (!manifest.memoryConfig || typeof manifest.memoryConfig !== 'object') {
      throw new OpError('INVALID_INPUT', 'manifest.memoryConfig is required');
    }

    const script = await scriptService.getById(scriptId);
    if (!script) throw new OpError('NOT_FOUND', `Script not found: ${scriptId}`);

    const result = await scriptVersionService.create({
      scriptId,
      manifest,
      label: versionLabel,
      note: versionNote ?? 'mcp: replace manifest',
      status: 'draft',
    });
    return {
      scriptId,
      newVersionId: result.version.id,
      newVersionNumber: result.version.versionNumber,
      created: result.created,
      note: result.created
        ? '已生成新 draft 版本。'
        : '与最新版本内容一致，未新建（hash 去重）。',
    };
  },
});
