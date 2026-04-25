/**
 * script.list_scripts —— 列出所有剧本（含每条最新/published 版本摘要）
 *
 * Admin 视角：能看到所有编剧的剧本，不按 authorUserId 过滤。
 * 输出的 scriptId 可以传给其它 op 定位剧本。
 */

import { z } from 'zod/v4';

import { defineOp } from '#internal/operations/op-kit';
import { scriptService } from '#internal/services/script-service';
import { scriptVersionService } from '#internal/services/script-version-service';

export const listScriptsInput = z.object({}).strict();

const scriptSummary = z.object({
  scriptId: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  authorUserId: z.string(),
  updatedAt: z.string(),
  versionCount: z.number().int().nonnegative(),
  publishedVersionId: z.string().nullable(),
  publishedVersionNumber: z.number().int().nullable(),
  latestVersionId: z.string().nullable(),
  latestVersionNumber: z.number().int().nullable(),
  latestVersionStatus: z.enum(['draft', 'published', 'archived']).nullable(),
});

export const listScriptsOutput = z.object({
  scripts: z.array(scriptSummary),
});

export const listScriptsOp = defineOp({
  name: 'script.list_scripts',
  description:
    '列出所有剧本（含 label / description / 最新版本信息）。Admin 能看所有编剧的剧本。' +
    '返回的每条 item 里 scriptId 可以传给其他 tool 定位剧本。',
  category: 'script',
  effect: 'safe',
  auth: 'admin',
  uiLabel: '列出剧本',
  input: listScriptsInput,
  output: listScriptsOutput,
  async exec() {
    const scripts = await scriptService.listAll();
    const enriched = await Promise.all(
      scripts.map(async (s) => {
        const versions = await scriptVersionService.listByScript(s.id);
        const published = versions.find((v) => v.status === 'published');
        const latest = versions[0] ?? null;
        return {
          scriptId: s.id,
          label: s.label,
          description: s.description,
          authorUserId: s.authorUserId,
          updatedAt: s.updatedAt.toISOString(),
          versionCount: versions.length,
          publishedVersionId: published?.id ?? null,
          publishedVersionNumber: published?.versionNumber ?? null,
          latestVersionId: latest?.id ?? null,
          latestVersionNumber: latest?.versionNumber ?? null,
          latestVersionStatus: latest?.status ?? null,
        };
      }),
    );
    return { scripts: enriched };
  },
});
