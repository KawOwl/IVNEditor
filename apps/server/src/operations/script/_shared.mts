/**
 * 共享给 script.* 系列 op 的小工具函数。
 *
 * 这些函数的前身是 `routes/mcp.mts` 里的本地 helper（getBaselineVersion /
 * findSegment / resolveTargetVersion 等）。迁移期把它们集中到这里，便于 op
 * 互相 import，也让 mcp.mts 那边随着 ToolDef 一个个搬走自然瘦身。
 *
 * 不在 op-kit.mts 里的原因：op-kit 是框架/领域无关的核心，这些是 script
 * 这一类业务专属的 helper，归 script/ 目录管。
 */

import type {
  ScriptManifest,
  PromptSegment,
} from '@ivn/core/types';

import { scriptVersionService, type ScriptVersionRow } from '#internal/services/script-version-service';
import { OpError } from '#internal/operations/errors';

/**
 * 解析"目标版本"。3 个 read-op + 1 个 write-op（update_segment）共用的逻辑：
 *  - 显式传 versionId → 直接 getById
 *  - 没传 → published 优先，fallback 最新（按 versionNumber desc）
 *  - 都找不到 → throw OpError NOT_FOUND
 *
 * 自动校验"版本属于该 script"（防止 versionId 是别人剧本的）。
 */
export async function resolveTargetVersion(
  scriptId: string,
  versionId: string | undefined,
): Promise<ScriptVersionRow> {
  let v: ScriptVersionRow | null;
  if (versionId) {
    v = await scriptVersionService.getById(versionId);
    if (!v) throw new OpError('NOT_FOUND', `Version not found: ${versionId}`);
    if (v.scriptId !== scriptId) {
      throw new OpError(
        'NOT_FOUND',
        `Version ${versionId} does not belong to script ${scriptId}`,
      );
    }
    return v;
  }
  v = await scriptVersionService.getCurrentPublished(scriptId);
  if (v) return v;
  const all = await scriptVersionService.listByScript(scriptId);
  if (all.length === 0) {
    throw new OpError('NOT_FOUND', `No versions exist for script ${scriptId}`);
  }
  v = await scriptVersionService.getById(all[0]!.id);
  if (!v) throw new OpError('NOT_FOUND', `Latest version vanished mid-query for script ${scriptId}`);
  return v;
}

/**
 * 取"基线版本"——写操作（update_segment / add_background / ...）的起点。
 * 与 resolveTargetVersion 区别：基线**总是取最新**（不管 published 还是
 * draft），不接受 versionId 参数。语义是"在最新状态上叠改"。
 */
export async function getBaselineVersion(scriptId: string): Promise<ScriptVersionRow> {
  const all = await scriptVersionService.listByScript(scriptId);
  if (all.length === 0) {
    throw new OpError('NOT_FOUND', `Script ${scriptId} has no versions to edit`);
  }
  const base = await scriptVersionService.getById(all[0]!.id);
  if (!base) throw new OpError('NOT_FOUND', 'Base version vanished mid-query');
  return base;
}

/** 在 manifest 里按 chapterId + segmentId 定位一个 segment，返回引用位置。 */
export function findSegment(
  manifest: ScriptManifest,
  chapterId: string,
  segmentId: string,
): { chapterIdx: number; segmentIdx: number; segment: PromptSegment } | null {
  const chapterIdx = manifest.chapters.findIndex((c) => c.id === chapterId);
  if (chapterIdx < 0) return null;
  const chapter = manifest.chapters[chapterIdx]!;
  const segmentIdx = chapter.segments.findIndex((s) => s.id === segmentId);
  if (segmentIdx < 0) return null;
  return { chapterIdx, segmentIdx, segment: chapter.segments[segmentIdx]! };
}

/** 深拷一份 manifest——写操作要 mutate manifest 之前用。 */
export function cloneManifest(m: ScriptManifest): ScriptManifest {
  return JSON.parse(JSON.stringify(m)) as ScriptManifest;
}
