/**
 * Operation Registry —— 全部 op 的"单一注册点"。
 *
 * 加新 op：在对应类别文件里 defineOp 之后，在这里 push 进 ALL_OPS。
 * 两个 adapter（HTTP / MCP）都从这里拿，不会漏。
 */

import type { AnyOp } from '#internal/operations/op-kit';
import { lintManifestOp } from '#internal/operations/script/lint-manifest';
import { listScriptsOp } from '#internal/operations/script/list-scripts';
import { listVersionsOp } from '#internal/operations/script/list-versions';
import { getOverviewOp } from '#internal/operations/script/get-overview';
import { getSegmentOp } from '#internal/operations/script/get-segment';
import { getFullManifestOp } from '#internal/operations/script/get-full-manifest';
import { listAssetsOp } from '#internal/operations/script/list-assets';
import { updateSegmentContentOp } from '#internal/operations/script/update-segment-content';
import { replaceManifestOp } from '#internal/operations/script/replace-manifest';
import { publishVersionOp } from '#internal/operations/script/publish-version';
import { uploadAssetOp } from '#internal/operations/script/upload-asset';
import { addBackgroundOp } from '#internal/operations/script/add-background';
import { addCharacterSpriteOp } from '#internal/operations/script/add-character-sprite';

/** 全部 op 列表。新增 op 在这里登记。*/
export const ALL_OPS = [
  // script.* —— 只读
  listScriptsOp,
  listVersionsOp,
  getOverviewOp,
  getSegmentOp,
  getFullManifestOp,
  listAssetsOp,
  lintManifestOp,
  // script.* —— 写
  updateSegmentContentOp,
  replaceManifestOp,
  publishVersionOp,
  // script.* —— 资产写
  uploadAssetOp,
  addBackgroundOp,
  addCharacterSpriteOp,
] as const satisfies ReadonlyArray<AnyOp>;

/** 按 category 分组（adapter / 文档生成器用）*/
export function groupOpsByCategory(): Record<string, ReadonlyArray<AnyOp>> {
  const out: Record<string, AnyOp[]> = {};
  for (const op of ALL_OPS) {
    (out[op.category] ??= []).push(op);
  }
  return out;
}
