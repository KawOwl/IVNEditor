/**
 * script.get_full_manifest —— 取剧本的完整 manifest（大 JSON）
 *
 * 用于需要对 manifest 做全局结构调整（加章节 / 改 stateSchema /
 * 调 memoryConfig / 改 promptAssemblyOrder 等）的场景。只改单 segment
 * 内容的话优先用 get_segment。
 */

import { z } from 'zod/v4';

import { defineOp } from '#internal/operations/op-kit';
import { resolveTargetVersion } from '#internal/operations/script/_shared';

export const getFullManifestInput = z.object({
  scriptId: z.string(),
  versionId: z.string().optional().describe('可选'),
}).strict();

// manifest 是 ScriptManifest，字段众多 + 嵌套深（chapters > segments > flowGraph
// 等等），op 层用 z.unknown 兜底，调用方按 @ivn/core 的 ScriptManifest 类型
// 解释。runtime 校验由真正消费 manifest 的 GameSession 做。
export const getFullManifestOutput = z.object({
  scriptId: z.string(),
  versionId: z.string(),
  versionNumber: z.number().int(),
  versionStatus: z.enum(['draft', 'published', 'archived']),
  manifest: z.unknown(),
});

export const getFullManifestOp = defineOp({
  name: 'script.get_full_manifest',
  description:
    '取剧本的完整 manifest（大 JSON）。用于需要对 manifest 做全局结构调整（加章节、改 stateSchema、' +
    '调 memoryConfig、改 promptAssemblyOrder 等）的场景。只做单 segment 内容改写的话优先用 get_segment。',
  category: 'script',
  effect: 'safe',
  auth: 'admin',
  uiLabel: '完整 manifest',
  input: getFullManifestInput,
  output: getFullManifestOutput,
  async exec({ scriptId, versionId }) {
    const version = await resolveTargetVersion(scriptId, versionId);
    return {
      scriptId,
      versionId: version.id,
      versionNumber: version.versionNumber,
      versionStatus: version.status,
      manifest: version.manifest,
    };
  },
});
