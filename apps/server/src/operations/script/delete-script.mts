/**
 * script.delete_script —— 【危险 · 不可逆】彻底删除剧本
 *
 * 级联删除（DB FK CASCADE 自动清）：
 *   - script_versions（draft / published / archived）
 *   - playthroughs（玩家和编剧试玩）
 *   - script_assets 数据库记录
 *
 * **OSS / S3 上的图片对象**不会被物理删除——只是 DB 引用没了。如需清理
 * 要管理员手动进 OSS 控制台按 key 前缀 `scripts/<scriptId>/` 删。
 *
 * 安全机制：两阶段确认。
 *   1. 不传 confirm（或 confirm=false）→ 返回 dry-run 预览（不删任何东西）
 *   2. 显式传 confirm: true + scriptIdConfirm === scriptId 才真删
 *
 * 这个 op 是**唯一**当前 effect='destructive' 的，将来增多时考虑把
 * 两阶段确认抽到 withConfirm middleware（防腐契约 #8）；现在 1 个 op
 * 不值得做抽象。
 */

import { z } from 'zod/v4';

import { defineOp } from '#internal/operations/op-kit';
import { OpError } from '#internal/operations/errors';
import { scriptService } from '#internal/services/script-service';
import { scriptVersionService } from '#internal/services/script-version-service';
import { assetService } from '#internal/services/asset-service';

export const deleteScriptInput = z.object({
  scriptId: z.string().describe('要删除的剧本 id'),
  scriptIdConfirm: z
    .string()
    .optional()
    .describe('再输一次 scriptId，必须和上面完全一致——防止传错。confirm=true 时必填'),
  confirm: z
    .boolean()
    .optional()
    .describe('必须传 true 才真删除；传 false 或不传 → 返回 "dry-run" 预览'),
}).strict();

const impactSchema = z.object({
  scriptId: z.string(),
  scriptLabel: z.string(),
  versionCount: z.number().int().nonnegative(),
  assetCount: z.number().int().nonnegative(),
  publishedVersionIds: z.array(z.string()),
  note: z.string(),
});

// 输出是 dry-run 与真删除的并集——保留旧 wire format，没动字段名
export const deleteScriptOutput = z.union([
  z.object({
    dryRun: z.literal(true),
    wouldDelete: impactSchema,
    message: z.string(),
  }),
  z.object({
    ok: z.literal(true),
    deleted: impactSchema,
    warning: z.string(),
  }),
]);

export const deleteScriptOp = defineOp({
  name: 'script.delete_script',
  description:
    '【危险 · 不可逆】彻底删除一个剧本。级联删除：该剧本的所有版本（draft / published / archived）、' +
    '所有 playthroughs（玩家和编剧试玩）、所有 script_assets 数据库记录。' +
    '**OSS / S3 上的图片对象**不会被物理删除（只是 DB 里的引用没了），如需清理要管理员手动进 OSS 控制台。\n\n' +
    '必须显式传 `confirm: true` + 同时传 `scriptIdConfirm` 与 `scriptId` 一致才真执行 —— 防止 LLM 误触。' +
    '强烈建议：调用前先用 `list_scripts` 和 `get_script_overview` 跟用户再次确认要删的是哪个剧本。',
  category: 'script',
  effect: 'destructive',
  auth: 'admin',
  uiLabel: '删除剧本（不可逆）',
  // mcpName 不变（旧 tool 名就是 delete_script）
  input: deleteScriptInput,
  output: deleteScriptOutput,
  async exec(input) {
    const { scriptId, scriptIdConfirm, confirm } = input;

    const script = await scriptService.getById(scriptId);
    if (!script) throw new OpError('NOT_FOUND', `Script not found: ${scriptId}`);

    const versions = await scriptVersionService.listByScript(scriptId);
    const assets = await assetService.listByScript(scriptId);
    const impact = {
      scriptId,
      scriptLabel: script.label,
      versionCount: versions.length,
      assetCount: assets.length,
      publishedVersionIds: versions.filter((v) => v.status === 'published').map((v) => v.id),
      note:
        '级联删除：script_versions / playthroughs / script_assets 的数据库行会被 FK CASCADE 自动清理。' +
        'OSS / S3 上的图片文件不会被物理删除。',
    };

    if (!confirm) {
      return {
        dryRun: true as const,
        wouldDelete: impact,
        message:
          '未传 confirm=true，已返回 dry-run。真要删请再调一次并带 `confirm: true`，同时 `scriptIdConfirm` 必须等于 scriptId。',
      };
    }
    if (scriptIdConfirm !== scriptId) {
      throw new OpError(
        'INVALID_INPUT',
        `Safety check failed: scriptIdConfirm (${scriptIdConfirm ?? '<missing>'}) does not match scriptId (${scriptId}). Re-enter scriptId in the scriptIdConfirm field to confirm.`,
      );
    }

    const ok = await scriptService.delete(scriptId);
    if (!ok) {
      throw new OpError('INTERNAL', `Delete failed (script vanished mid-op?): ${scriptId}`);
    }

    return {
      ok: true as const,
      deleted: impact,
      warning:
        `OSS 上的 asset 文件未物理删除。如需清理，请在 OSS 控制台按 key 前缀 scripts/${scriptId}/ 手动删除。`,
    };
  },
});
