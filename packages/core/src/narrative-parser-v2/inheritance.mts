/**
 * Narrative Parser v2 — 视觉状态推导（暂时简化版）
 *
 * 简化规则（覆盖 RFC §3.4 旧设计）：
 *   - **dialogue 单元**：sprites = [speaker 立绘 at center]
 *     - 已知 speaker（manifest.characters 含该 id）→ 用该 character 的 default
 *       mood；缺 default mood（作者还没上传 sprite 资产）→ emotion 空串，UI
 *       占位卡片兜底渲染。
 *     - ad-hoc speaker（`__npc__保安` 等）→ 映射到 reserved character id
 *       `__npc__` 查找；作者在编辑器添加了 `__npc__` 角色就触发，没添加则空台。
 *     - 不在白名单（杜撰角色）→ 空台。
 *   - **非 dialogue 单元**（narration / speakerMissing）→ sprites = []。
 *   - 完全不继承 prev.sprites，完全忽略 `<sprite>` / `<stage/>` 子标签：立绘
 *     绑定到 dialogue 容器生命周期——dialogue 关闭时立绘随之退场。
 *
 * 背景规则不变：pending bg 通过白名单则切换，否则继承 + emit
 * `bg-unknown-scene`。
 *
 * 纯函数。不 mutate 输入。不做 IO。
 */

import type { SceneState, SpriteState } from '#internal/types';
import type { PendingUnit, ParserManifest, DegradeEvent } from '#internal/narrative-parser-v2/state';
import {
  isAdhocSpeaker,
  NPC_RESERVED_CHARACTER_ID,
} from '#internal/narrative-parser-v2/tag-schema';

// ============================================================================
// 输出形状
// ============================================================================

export interface ResolvedScene {
  readonly scene: SceneState;
  readonly bgChanged: boolean;
  readonly spritesChanged: boolean;
  readonly degrades: ReadonlyArray<DegradeEvent>;
}

// ============================================================================
// 主入口
// ============================================================================

export function resolveScene(
  prev: SceneState,
  pending: PendingUnit,
  manifest: ParserManifest,
): ResolvedScene {
  const degrades: DegradeEvent[] = [];

  const nextBg = resolveBackground(prev.background, pending, manifest, degrades);
  const nextSprites = resolveSpeakerSprite(pending, manifest);

  const bgChanged = nextBg !== prev.background;
  const spritesChanged = !spritesEqual(nextSprites, prev.sprites);

  return {
    scene: { background: nextBg, sprites: nextSprites },
    bgChanged,
    spritesChanged,
    degrades,
  };
}

// ============================================================================
// 子规则
// ============================================================================

function resolveBackground(
  prevBg: string | null,
  pending: PendingUnit,
  manifest: ParserManifest,
  degrades: DegradeEvent[],
): string | null {
  if (!pending.pendingBg) return prevBg;
  const { scene } = pending.pendingBg;
  if (!manifest.backgrounds.has(scene)) {
    degrades.push({ code: 'bg-unknown-scene', detail: scene });
    return prevBg;
  }
  return scene;
}

/**
 * 简化版立绘规则：dialogue → [speaker 立绘 at center]，其余 → []。
 *
 * Lookup id 映射：ad-hoc speaker（`__npc__保安`）统一映射到 reserved id
 * `__npc__`（`NPC_RESERVED_CHARACTER_ID`），所有 ad-hoc 共用作者在 manifest
 * 配的占位 character。
 *
 * Skip 条件（任一命中 → 返回空数组）：
 *   - 非 dialogue 单元
 *   - speaker 缺失（已被 reducer 降级 narration）
 *   - speaker pf 字段为空
 *   - lookup id 不在 manifest.characters 白名单（杜撰 / 作者没配 `__npc__`）
 *
 * Emotion 兜底：lookup id 在白名单但 manifest 没给该 character 配过 sprite
 * 资产（`defaultMoodByChar` 缺 key）→ emotion 用空字符串，让 UI SpriteLayer
 * 走"无 assetUrl → 占位卡片"的现有 fallback 路径（显示 displayName 框）。
 *
 * 不读 prev.sprites、不读 pending.pendingSprites、不读 pending.pendingClearStage：
 * 每个单元独立从 manifest 推导，立绘随 dialogue 容器生命周期出场/退场。
 */
function resolveSpeakerSprite(
  pending: PendingUnit,
  manifest: ParserManifest,
): SpriteState[] {
  if (pending.kind !== 'dialogue') return [];
  if (pending.speakerMissing) return [];
  const speaker = pending.pf?.speaker;
  if (!speaker) return [];
  const lookupId = isAdhocSpeaker(speaker) ? NPC_RESERVED_CHARACTER_ID : speaker;
  if (!manifest.characters.has(lookupId)) return [];
  const emotion = manifest.defaultMoodByChar.get(lookupId) ?? '';
  return [{ id: lookupId, emotion, position: 'center' }];
}

// ============================================================================
// 对比辅助
// ============================================================================

function spritesEqual(
  a: ReadonlyArray<SpriteState>,
  b: ReadonlyArray<SpriteState>,
): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    if (!y) return false;
    return x.id === y.id && x.emotion === y.emotion && x.position === y.position;
  });
}
