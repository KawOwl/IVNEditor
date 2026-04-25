/**
 * script.add_character_sprite —— 【高阶】上传立绘 + 加到 manifest + 建新 draft
 *
 * - 角色不存在时自动创建（此时 characterDisplayName 必填）
 * - spriteId 已存在 → 覆盖；否则新增
 * - 不自动 publish
 *
 * 这是修复 trace 类 character-not-defined / emotion-not-defined 缺
 * 立绘问题的常用入口。
 */

import { z } from 'zod/v4';

import { defineOp } from '#internal/operations/op-kit';
import { OpError } from '#internal/operations/errors';
import { scriptVersionService } from '#internal/services/script-version-service';
import {
  cloneManifest,
  getBaselineVersion,
} from '#internal/operations/script/_shared';
import {
  characterSpriteResultNote,
  characterSpriteVersionNote,
  replaceCharacterAt,
  uploadImageBytes,
  upsertCharacter,
  upsertSpriteAsset,
} from '#internal/operations/script/_asset-helpers';

export const addCharacterSpriteInput = z.object({
  scriptId: z.string(),
  characterId: z
    .string()
    .describe('snake_case 角色 id，会被 LLM 在 change_sprite / <sprite char="..."> 里引用。例：aonkei'),
  characterDisplayName: z
    .string()
    .optional()
    .describe('角色不存在时必填：UI 呈现名，如 "昂晴"。已存在传入会更新 displayName'),
  spriteId: z
    .string()
    .describe('snake_case 表情 / 姿态 id，例：smiling / crying / praying'),
  spriteLabel: z.string().optional().describe('可选：人读描述'),
  contentType: z.string(),
  imageBase64: z.string(),
  versionLabel: z.string().optional(),
  versionNote: z.string().optional(),
}).strict();

export const addCharacterSpriteOutput = z.object({
  scriptId: z.string(),
  characterId: z.string(),
  spriteId: z.string(),
  assetUrl: z.string(),
  assetId: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  createdCharacter: z.boolean(),
  replacedSprite: z.boolean(),
  baseVersionId: z.string(),
  newVersionId: z.string(),
  newVersionNumber: z.number().int(),
  note: z.string(),
});

export const addCharacterSpriteOp = defineOp({
  name: 'script.add_character_sprite',
  description:
    '【高阶】上传一张角色立绘 + 把它作为 SpriteAsset 加到 manifest.characters[id=characterId].sprites[] ' +
    '+ 建新 draft 版本。如果 character 还不存在会自动创建（此时 characterDisplayName 必填）。' +
    '如果 spriteId 在该角色下已存在，会用新图覆盖。不自动 publish。',
  category: 'script',
  effect: 'mutating',
  auth: 'admin',
  uiLabel: '加立绘（高阶）',
  // mcpName 不需要 override —— add_character_sprite 已经是干净的命名
  input: addCharacterSpriteInput,
  output: addCharacterSpriteOutput,
  async exec(input, ctx) {
    if (!ctx.userId) {
      throw new OpError('UNAUTHORIZED', 'add_character_sprite requires authenticated user');
    }
    const base = await getBaselineVersion(input.scriptId);
    const manifest = cloneManifest(base.manifest);

    const characterUpsert = upsertCharacter(
      manifest.characters ?? [],
      input.characterId,
      input.characterDisplayName,
    );

    const asset = await uploadImageBytes({
      scriptId: input.scriptId,
      kind: 'sprite',
      contentType: input.contentType,
      imageBase64: input.imageBase64,
      originalName: `${input.characterId}-${input.spriteId}`,
      uploadedByUserId: ctx.userId,
    });

    const spriteUpsert = upsertSpriteAsset(
      characterUpsert.characters[characterUpsert.characterIndex]!,
      input.spriteId,
      asset.assetUrl,
      input.spriteLabel,
    );

    manifest.characters = replaceCharacterAt(
      characterUpsert.characters,
      characterUpsert.characterIndex,
      spriteUpsert.character,
    );

    const result = await scriptVersionService.create({
      scriptId: input.scriptId,
      manifest,
      label: input.versionLabel,
      note:
        input.versionNote
        ?? characterSpriteVersionNote({
          characterId: input.characterId,
          spriteId: input.spriteId,
          createdCharacter: characterUpsert.createdCharacter,
          replacedSprite: spriteUpsert.replacedSprite,
        }),
      status: 'draft',
    });

    return {
      scriptId: input.scriptId,
      characterId: input.characterId,
      spriteId: input.spriteId,
      assetUrl: asset.assetUrl,
      assetId: asset.assetId,
      sizeBytes: asset.sizeBytes,
      createdCharacter: characterUpsert.createdCharacter,
      replacedSprite: spriteUpsert.replacedSprite,
      baseVersionId: base.id,
      newVersionId: result.version.id,
      newVersionNumber: result.version.versionNumber,
      note: characterSpriteResultNote(
        characterUpsert.createdCharacter,
        spriteUpsert.replacedSprite,
      ),
    };
  },
});
