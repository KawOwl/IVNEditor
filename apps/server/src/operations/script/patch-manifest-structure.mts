/**
 * script.patch_manifest_structure —— 偏 patch：只替换 manifest 的结构字段，
 * 章节 / segments 原样保留
 *
 * 用于 agent 想改 characters / backgrounds / stateSchema / memoryConfig /
 * promptAssemblyOrder，又不想把整张 manifest（含所有 segment.content）回传
 * 的场景。每个字段独立可选；只传几个字段就只覆盖那几个。
 *
 * 提供的字段做"整体替换"语义（不做 by-id upsert / merge）。比如想加一条
 * character 不动其他，要先 get_full_manifest 把 characters 数组拿回来 append
 * 后再传整个 characters。
 *
 * 沿用 replace_script_manifest 的"最少校验"哲学：每个字段只做最浅形状校验
 * （是不是数组 / 对象、必备子字段是否齐全），不深 zod。GameSession runtime
 * 才是真 schema 把关。
 */

import { z } from 'zod/v4';

import type { ScriptManifest } from '@ivn/core/types';

import { defineOp } from '#internal/operations/op-kit';
import { OpError } from '#internal/operations/errors';
import { scriptVersionService } from '#internal/services/script-version-service';
import {
  cloneManifest,
  getBaselineVersion,
} from '#internal/operations/script/_shared';

export const patchManifestStructureInput = z.object({
  scriptId: z.string(),
  characters: z
    .unknown()
    .optional()
    .describe('整体替换 manifest.characters（CharacterAsset[]）。要清空传 []。'),
  backgrounds: z
    .unknown()
    .optional()
    .describe('整体替换 manifest.backgrounds（BackgroundAsset[]）。要清空传 []。'),
  stateSchema: z
    .unknown()
    .optional()
    .describe('整体替换 manifest.stateSchema（{ variables: StateVariable[] }）。'),
  memoryConfig: z
    .unknown()
    .optional()
    .describe('整体替换 manifest.memoryConfig（MemoryConfig）。'),
  promptAssemblyOrder: z
    .unknown()
    .optional()
    .describe('整体替换 manifest.promptAssemblyOrder（string[] section ID）。'),
  versionLabel: z.string().optional(),
  versionNote: z.string().optional(),
}).strict();

export const patchManifestStructureOutput = z.object({
  scriptId: z.string(),
  baseVersionId: z.string(),
  baseVersionNumber: z.number().int(),
  newVersionId: z.string(),
  newVersionNumber: z.number().int(),
  created: z.boolean(),
  patchedFields: z.array(z.string()),
  note: z.string(),
});

/** patch 输入字段名（即 PatchableFields 的 key），用于 doc / log 复用 */
const PATCHABLE_FIELDS = [
  'characters',
  'backgrounds',
  'stateSchema',
  'memoryConfig',
  'promptAssemblyOrder',
] as const;

interface PatchInput {
  characters?: unknown;
  backgrounds?: unknown;
  stateSchema?: unknown;
  memoryConfig?: unknown;
  promptAssemblyOrder?: unknown;
}

/**
 * 把 patch 字段就地写到 manifest（已 clone 过的）上，沿用最少校验。
 * 抽成纯函数是为了单测能脱离 service 层验证 invariant：
 *  - 提供的字段被覆盖
 *  - 未提供的字段保持基线
 *  - chapters / segments 全程不动
 */
function applyStructuralPatch(
  manifest: ScriptManifest,
  input: PatchInput,
): { patchedFields: string[] } {
  const patchedFields: string[] = [];

  if (input.characters !== undefined) {
    if (!Array.isArray(input.characters)) {
      throw new OpError('INVALID_INPUT', 'characters must be an array');
    }
    manifest.characters = input.characters as ScriptManifest['characters'];
    patchedFields.push('characters');
  }

  if (input.backgrounds !== undefined) {
    if (!Array.isArray(input.backgrounds)) {
      throw new OpError('INVALID_INPUT', 'backgrounds must be an array');
    }
    manifest.backgrounds = input.backgrounds as ScriptManifest['backgrounds'];
    patchedFields.push('backgrounds');
  }

  if (input.stateSchema !== undefined) {
    if (!input.stateSchema || typeof input.stateSchema !== 'object') {
      throw new OpError('INVALID_INPUT', 'stateSchema must be an object');
    }
    const ss = input.stateSchema as { variables?: unknown };
    if (!Array.isArray(ss.variables)) {
      throw new OpError('INVALID_INPUT', 'stateSchema.variables must be an array');
    }
    manifest.stateSchema = input.stateSchema as ScriptManifest['stateSchema'];
    patchedFields.push('stateSchema');
  }

  if (input.memoryConfig !== undefined) {
    if (!input.memoryConfig || typeof input.memoryConfig !== 'object') {
      throw new OpError('INVALID_INPUT', 'memoryConfig must be an object');
    }
    manifest.memoryConfig = input.memoryConfig as ScriptManifest['memoryConfig'];
    patchedFields.push('memoryConfig');
  }

  if (input.promptAssemblyOrder !== undefined) {
    if (!Array.isArray(input.promptAssemblyOrder)) {
      throw new OpError('INVALID_INPUT', 'promptAssemblyOrder must be an array');
    }
    manifest.promptAssemblyOrder =
      input.promptAssemblyOrder as ScriptManifest['promptAssemblyOrder'];
    patchedFields.push('promptAssemblyOrder');
  }

  return { patchedFields };
}

export const patchManifestStructureOp = defineOp({
  name: 'script.patch_manifest_structure',
  description:
    '只替换 manifest 的结构字段（characters / backgrounds / stateSchema / ' +
    'memoryConfig / promptAssemblyOrder），章节 segments 内容原样保留，' +
    '基于最新版本建新 draft。提供的字段做整体替换（非 by-id upsert）。' +
    '比 replace_script_manifest 省 token：agent 不需要把所有 segment.content 回传。' +
    '不自动 publish。',
  category: 'script',
  effect: 'mutating',
  auth: 'admin',
  uiLabel: '改 manifest 结构（保留段落）',
  input: patchManifestStructureInput,
  output: patchManifestStructureOutput,
  async exec(input) {
    const { scriptId, versionLabel, versionNote, ...patch } = input;

    const base = await getBaselineVersion(scriptId);
    const manifest = cloneManifest(base.manifest);

    const { patchedFields } = applyStructuralPatch(manifest, patch);

    if (patchedFields.length === 0) {
      throw new OpError(
        'INVALID_INPUT',
        `at least one of ${PATCHABLE_FIELDS.join(' / ')} must be provided`,
      );
    }

    const result = await scriptVersionService.create({
      scriptId,
      manifest,
      label: versionLabel,
      note: versionNote ?? `mcp: patch manifest structure (${patchedFields.join(', ')})`,
      status: 'draft',
    });

    return {
      scriptId,
      baseVersionId: base.id,
      baseVersionNumber: base.versionNumber,
      newVersionId: result.version.id,
      newVersionNumber: result.version.versionNumber,
      created: result.created,
      patchedFields,
      note: result.created
        ? `已生成新 draft 版本（更新字段：${patchedFields.join(', ')}）。`
        : '与最新版本内容一致，未新建（hash 去重）。',
    };
  },
});

export const _internal = {
  applyStructuralPatch,
  PATCHABLE_FIELDS,
};
