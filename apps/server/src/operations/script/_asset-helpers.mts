/**
 * 资产 op 共享 helper —— upload_script_asset / add_background_to_script /
 * add_character_sprite 共用的图片 base64 解码、S3 上传、manifest upsert
 * 等逻辑。
 *
 * 这些函数的前身是 `routes/mcp.mts` 顶部一大批 helper（extFromMime /
 * stripBase64Prefix / decodeBase64Image / uploadImageBytes /
 * upsertBackgroundAsset / upsertCharacter / upsertSpriteAsset 等）。
 *
 * 搬出来的目的：让 op 文件保持薄，且这些底层 helper 不依赖 mcp 协议
 * （UploadedAsset 是普通 plain object，不是 MCP textResult）。
 */

import { randomUUID } from 'node:crypto';

import type {
  BackgroundAsset,
  CharacterAsset,
  ScriptManifest,
  SpriteAsset,
} from '@ivn/core/types';

import { OpError } from '#internal/operations/errors';
import { scriptService } from '#internal/services/script-service';
import { assetService, type AssetKind } from '#internal/services/asset-service';
import { getAssetStorage } from '#internal/services/asset-storage';

// ============================================================================
// 常量
// ============================================================================

/** 解码后的原始字节上限（不是 base64 字符串长度）*/
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;

/** 允许的图片 MIME 白名单 */
export const ALLOWED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'image/avif',
]);

// ============================================================================
// 编解码 helper
// ============================================================================

/** MIME → 文件扩展名（routes/assets.ts 同款，不引依赖避免循环） */
export function extFromMime(mime: string | undefined): string {
  if (!mime) return '';
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'image/avif': '.avif',
  };
  return map[mime.toLowerCase()] ?? '';
}

/**
 * 从 data URL / 裸 base64 串里取出真实 base64 payload。
 * Claude Desktop / 各种 MCP client 传图片时格式不统一：
 *   - 裸 base64（纯 A-Z a-z 0-9 +/= 序列）
 *   - `data:image/png;base64,iVBOR...`
 */
export function stripBase64Prefix(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(/^data:[^;]+;base64,(.+)$/i);
  return m ? m[1]! : trimmed;
}

/** base64 → Buffer，失败抛友好错误 */
export function decodeBase64Image(raw: string): Uint8Array {
  const payload = stripBase64Prefix(raw);
  // Node / Bun 的 Buffer.from 对非法 base64 不抛错、会悄悄丢字符，所以自检一下
  if (!/^[A-Za-z0-9+/=\s]+$/.test(payload)) {
    throw new OpError('INVALID_INPUT', 'imageBase64 contains non-base64 characters');
  }
  const buf = Buffer.from(payload, 'base64');
  if (buf.length === 0) {
    throw new OpError('INVALID_INPUT', 'imageBase64 decoded to empty bytes');
  }
  return new Uint8Array(buf);
}

// ============================================================================
// 上传到 S3 + 写 script_assets 表
// ============================================================================

export interface UploadedAsset {
  assetId: string;
  storageKey: string;
  assetUrl: string;
  sizeBytes: number;
  contentType: string;
  kind: AssetKind;
}

/**
 * 把 base64 解码后的图片流式上传到 S3 并记录到 script_assets 表。
 * 三个 asset op 共享此函数。**不做 manifest 更新**，那是 caller 的事。
 */
export async function uploadImageBytes(params: {
  scriptId: string;
  kind: AssetKind;
  contentType: string;
  imageBase64: string;
  originalName?: string;
  uploadedByUserId: string;
}): Promise<UploadedAsset> {
  const contentType = params.contentType.toLowerCase();
  if (!ALLOWED_IMAGE_MIMES.has(contentType)) {
    throw new OpError(
      'INVALID_INPUT',
      `Unsupported contentType: ${params.contentType}. Allowed: ${Array.from(ALLOWED_IMAGE_MIMES).join(', ')}`,
    );
  }

  const bytes = decodeBase64Image(params.imageBase64);
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    throw new OpError(
      'INVALID_INPUT',
      `Image too large: ${bytes.byteLength} bytes (max ${MAX_ASSET_BYTES}). Either compress the image or split it.`,
    );
  }

  const ownerId = await scriptService.getOwnerId(params.scriptId);
  if (!ownerId) throw new OpError('NOT_FOUND', `Script not found: ${params.scriptId}`);

  const assetId = randomUUID();
  const ext = extFromMime(contentType);
  const storageKey = `scripts/${params.scriptId}/${assetId}${ext}`;

  const storage = getAssetStorage();
  // Bun 的 Blob.stream() 返回 Web ReadableStream，S3AssetStorage.put 接受它
  const stream = new Blob([bytes as unknown as BlobPart], { type: contentType }).stream();

  await storage.put(storageKey, stream, contentType, {
    app: 'ivn-engine',
    'script-id': params.scriptId,
    'asset-kind': params.kind,
    'uploaded-by': params.uploadedByUserId,
    source: 'mcp',
  });

  const row = await assetService.create({
    id: assetId,
    scriptId: params.scriptId,
    kind: params.kind,
    storageKey,
    originalName: params.originalName ?? null,
    contentType,
    sizeBytes: bytes.byteLength,
  });

  return {
    assetId: row.id,
    storageKey: row.storageKey,
    assetUrl: `/api/assets/${row.storageKey}`,
    sizeBytes: row.sizeBytes ?? bytes.byteLength,
    contentType: row.contentType ?? contentType,
    kind: row.kind,
  };
}

// ============================================================================
// Background upsert
// ============================================================================

export interface BackgroundUpsert {
  backgrounds: BackgroundAsset[];
  replaced: boolean;
}

export function upsertBackgroundAsset(
  backgrounds: BackgroundAsset[],
  backgroundId: string,
  assetUrl: string,
  label: string | undefined,
): BackgroundUpsert {
  const idx = backgrounds.findIndex((b) => b.id === backgroundId);
  const patch = { assetUrl, ...(label !== undefined ? { label } : {}) };

  if (idx >= 0) {
    const updated = [...backgrounds];
    updated[idx] = { ...updated[idx]!, ...patch };
    return { backgrounds: updated, replaced: true };
  }
  return {
    backgrounds: [...backgrounds, { id: backgroundId, ...patch }],
    replaced: false,
  };
}

export function backgroundVersionNote(backgroundId: string, replaced: boolean): string {
  return `mcp: ${replaced ? 'update' : 'add'} background ${backgroundId}`;
}

export function backgroundResultNote(replaced: boolean): string {
  return replaced
    ? '已覆盖同名 background，并生成新 draft 版本。'
    : '已新增 background，并生成新 draft 版本。';
}

// ============================================================================
// Character + sprite upsert
// ============================================================================

export interface CharacterUpsert {
  characters: CharacterAsset[];
  characterIndex: number;
  createdCharacter: boolean;
}

export function upsertCharacter(
  characters: CharacterAsset[],
  characterId: string,
  characterDisplayName: string | undefined,
): CharacterUpsert {
  const idx = characters.findIndex((c) => c.id === characterId);
  if (idx < 0) {
    if (!characterDisplayName) {
      throw new OpError(
        'INVALID_INPUT',
        `Character ${characterId} does not exist yet; please provide characterDisplayName to create it.`,
      );
    }
    return {
      characters: [
        ...characters,
        { id: characterId, displayName: characterDisplayName, sprites: [] },
      ],
      characterIndex: characters.length,
      createdCharacter: true,
    };
  }
  if (!characterDisplayName) {
    return { characters, characterIndex: idx, createdCharacter: false };
  }
  const renamed = [...characters];
  renamed[idx] = { ...renamed[idx]!, displayName: characterDisplayName };
  return { characters: renamed, characterIndex: idx, createdCharacter: false };
}

export interface SpriteUpsert {
  character: CharacterAsset;
  replacedSprite: boolean;
}

export function upsertSpriteAsset(
  character: CharacterAsset,
  spriteId: string,
  assetUrl: string,
  spriteLabel: string | undefined,
): SpriteUpsert {
  const sprites: SpriteAsset[] = [...character.sprites];
  const idx = sprites.findIndex((s) => s.id === spriteId);
  const patch = { assetUrl, ...(spriteLabel !== undefined ? { label: spriteLabel } : {}) };

  if (idx >= 0) {
    sprites[idx] = { ...sprites[idx]!, ...patch };
    return { character: { ...character, sprites }, replacedSprite: true };
  }
  sprites.push({ id: spriteId, ...patch });
  return { character: { ...character, sprites }, replacedSprite: false };
}

export function replaceCharacterAt(
  characters: CharacterAsset[],
  characterIndex: number,
  character: CharacterAsset,
): CharacterAsset[] {
  const updated = [...characters];
  updated[characterIndex] = character;
  return updated;
}

export function characterSpriteVersionNote(params: {
  characterId: string;
  spriteId: string;
  createdCharacter: boolean;
  replacedSprite: boolean;
}): string {
  return (
    `mcp: ${params.createdCharacter ? 'create character + ' : ''}` +
    `${params.replacedSprite ? 'update' : 'add'} sprite ${params.characterId}/${params.spriteId}`
  );
}

export function characterSpriteResultNote(
  createdCharacter: boolean,
  replacedSprite: boolean,
): string {
  return createdCharacter
    ? '已新建 character 并挂入第一张立绘，生成新 draft 版本。'
    : replacedSprite
      ? '已覆盖同名 sprite，生成新 draft 版本。'
      : '已为现有 character 新增一张 sprite，生成新 draft 版本。';
}

// ============================================================================
// Re-export 便利
// ============================================================================

export type { ScriptManifest };
