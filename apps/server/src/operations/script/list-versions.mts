/**
 * script.list_versions —— 列出某剧本的所有版本（不含 manifest 大字段）
 *
 * 给编辑器版本下拉 / agent 找历史 draft 用。manifest 太大，所以这里只返
 * summary（id / number / status / label / note / createdAt / publishedAt）。
 */

import { z } from 'zod/v4';

import { defineOp } from '#internal/operations/op-kit';
import { OpError } from '#internal/operations/errors';
import { scriptService } from '#internal/services/script-service';
import { scriptVersionService } from '#internal/services/script-version-service';

export const listVersionsInput = z.object({
  scriptId: z.string().describe('剧本 id（见 list_scripts）'),
}).strict();

const versionSummary = z.object({
  versionId: z.string(),
  versionNumber: z.number().int(),
  status: z.enum(['draft', 'published', 'archived']),
  label: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  publishedAt: z.string().nullable(),
});

export const listVersionsOutput = z.object({
  scriptId: z.string(),
  versions: z.array(versionSummary),
});

export const listVersionsOp = defineOp({
  name: 'script.list_versions',
  description: '列出某剧本的所有版本（draft / published / archived）。不含 manifest 大字段。',
  category: 'script',
  effect: 'safe',
  auth: 'admin',
  uiLabel: '列出版本',
  mcpName: 'list_script_versions', // backward compat：旧 MCP 客户端用 list_script_versions
  input: listVersionsInput,
  output: listVersionsOutput,
  async exec({ scriptId }) {
    const owner = await scriptService.getOwnerId(scriptId);
    if (!owner) throw new OpError('NOT_FOUND', `Script not found: ${scriptId}`);
    const versions = await scriptVersionService.listByScript(scriptId);
    return {
      scriptId,
      versions: versions.map((v) => ({
        versionId: v.id,
        versionNumber: v.versionNumber,
        status: v.status,
        label: v.label,
        note: v.note,
        createdAt: v.createdAt.toISOString(),
        publishedAt: v.publishedAt?.toISOString() ?? null,
      })),
    };
  },
});
