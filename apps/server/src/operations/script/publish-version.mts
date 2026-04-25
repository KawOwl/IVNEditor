/**
 * script.publish_version —— 把 draft 发布为 published
 *
 * 副作用：该剧本之前的 published 版本会被自动 archive 掉。
 * **影响玩家**：一旦 publish，该剧本所有新 playthrough 走这个版本。
 * 老 playthrough 维持原版本（playthroughs.scriptVersionId 是 immutable）。
 */

import { z } from 'zod/v4';

import { defineOp } from '#internal/operations/op-kit';
import { OpError } from '#internal/operations/errors';
import { scriptVersionService } from '#internal/services/script-version-service';

export const publishVersionInput = z.object({
  versionId: z.string().describe('要发布的 draft 版本 id（见 list_script_versions）'),
}).strict();

export const publishVersionOutput = z.object({
  ok: z.literal(true),
  publishedVersionId: z.string(),
  scriptId: z.string(),
  versionNumber: z.number().int(),
});

export const publishVersionOp = defineOp({
  name: 'script.publish_version',
  description:
    '把一个 draft 版本发布为 published（会把该剧本之前的 published 版本自动 archive 掉）。' +
    '**有玩家影响**：一旦 publish，该剧本所有新 playthrough 会走这个版本。',
  category: 'script',
  effect: 'mutating',
  auth: 'admin',
  uiLabel: '发布版本',
  mcpName: 'publish_script_version', // backward compat
  input: publishVersionInput,
  output: publishVersionOutput,
  async exec({ versionId }) {
    const target = await scriptVersionService.getById(versionId);
    if (!target) throw new OpError('NOT_FOUND', `Version not found: ${versionId}`);
    if (target.status !== 'draft') {
      throw new OpError(
        'CONFLICT',
        `Cannot publish: version is ${target.status}, only draft can be published`,
      );
    }
    const ok = await scriptVersionService.publish(versionId);
    if (!ok) throw new OpError('INTERNAL', 'Publish failed');
    return {
      ok: true as const,
      publishedVersionId: versionId,
      scriptId: target.scriptId,
      versionNumber: target.versionNumber,
    };
  },
});
