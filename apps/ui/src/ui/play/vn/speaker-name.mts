/**
 * VN speaker 显示名解析 —— DialogBox / Backlog 共用。
 *
 * 处理顺序：
 *   1. 系统约定 id（'player' / 'unknown'）→ 固定文案
 *   2. ad-hoc NPC（`__npc__保安` 等）→ strip 前缀，后缀就是显示名；
 *      后缀为空（裸 `__npc__`）退化到 `？`
 *   3. 白名单 manifest 角色 → manifest.displayName，缺失 fallback id
 *   4. 完全陌生 id → 原样显示（degrade 已在 parser 层报）
 */

import type { CharacterAsset } from '@ivn/core/types';
import {
  adhocDisplayName,
  isAdhocSpeaker,
} from '@ivn/core/narrative-parser-v2';

export function resolveSpeakerName(
  speakerId: string,
  characters: ReadonlyArray<CharacterAsset>,
): string {
  if (speakerId === 'player') return '我';
  if (speakerId === 'unknown') return '？';
  if (isAdhocSpeaker(speakerId)) {
    const display = adhocDisplayName(speakerId).trim();
    return display.length > 0 ? display : '？';
  }
  const c = characters.find((ch) => ch.id === speakerId);
  return c?.displayName ?? speakerId;
}
