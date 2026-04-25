/**
 * script.delete_script —— 【危险 · 可恢复】软删除剧本
 *
 * 实现：UPDATE scripts SET deleted_at = NOW() WHERE id = $1。不真物理删，
 * 因此：
 *   - script_versions / playthroughs / script_assets / OSS 资产全部保留不动
 *   - Langfuse trace、玩家游玩 backlog 都还查得到（只是 list_scripts 看不见）
 *   - 创建试玩 / 编辑该 script 会被拒（404）
 *   - 误删恢复：直接 SQL `UPDATE scripts SET deleted_at = NULL WHERE id = ...`
 *
 * 历史：上一版是硬删 + 依赖 FK CASCADE，但 playthroughs.script_version_id FK
 * 是 no-action（migration 0002），cascade 链断在 script_versions → playthroughs
 * 这一步，所有真删都 PG FK violation → 500。改软删彻底 sidestep。
 *
 * 安全机制：两阶段确认仍保留（删剧本是大事，即使可恢复也不要一键即触发）。
 *   1. 不传 confirm（或 confirm=false）→ 返回 dry-run 预览
 *   2. 显式传 confirm: true + scriptIdConfirm === scriptId 才真改
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
    '【危险 · 可恢复】软删除一个剧本：UPDATE scripts SET deleted_at = NOW()。' +
    '剧本从 list_scripts / get_script_overview 消失、不能再被试玩或编辑，' +
    '但底层 script_versions / playthroughs / script_assets / OSS 资产**全部保留不动**——' +
    '玩家游玩 backlog 和 Langfuse trace 仍可查。误删恢复：让 admin 直接 SQL ' +
    '`UPDATE scripts SET deleted_at = NULL WHERE id = ...`。\n\n' +
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
        '软删除：scripts.deleted_at 设为当前时间。script_versions / playthroughs / ' +
        'script_assets / OSS 资产全部保留不动。剧本从 list_scripts 消失、不能再被' +
        '试玩或编辑，但 backlog 和 trace 仍可查。',
    };

    if (!confirm) {
      return {
        dryRun: true as const,
        wouldDelete: impact,
        message:
          '未传 confirm=true，已返回 dry-run。真要软删请再调一次并带 `confirm: true`，同时 `scriptIdConfirm` 必须等于 scriptId。',
      };
    }
    if (scriptIdConfirm !== scriptId) {
      throw new OpError(
        'INVALID_INPUT',
        `Safety check failed: scriptIdConfirm (${scriptIdConfirm ?? '<missing>'}) does not match scriptId (${scriptId}). Re-enter scriptId in the scriptIdConfirm field to confirm.`,
      );
    }

    const ok = await scriptService.softDelete(scriptId);
    if (!ok) {
      throw new OpError('INTERNAL', `Soft delete failed (script vanished mid-op?): ${scriptId}`);
    }

    return {
      ok: true as const,
      deleted: impact,
      warning:
        '已软删除（行没有物理删除）。如要恢复，让 admin 直接 SQL `UPDATE scripts SET deleted_at = NULL WHERE id = ' +
        `'${scriptId}'\`。`,
    };
  },
});
