/**
 * Narrative Parser v2 — 视觉状态继承推导
 *
 * RFC §3.4 的 TypeScript 编码。**纯函数**：接一个 prev scene 和 pending 的
 * 视觉子标签，产出 resolved scene + change flags + degrades。
 *
 * 不 mutate 输入。不做 IO。不依赖 htmlparser2。
 */

import type { SceneState, SpriteState } from '../types';
import type { PendingUnit, ParserManifest, DegradeEvent } from './state';

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
// 继承规则主入口
// ============================================================================

/**
 * 按 RFC §3.4 推导该单元最终的视觉状态：
 *
 *   bg:
 *     - 子里有 <background/> 且 scene 通过校验 → 用新值
 *     - 否则 → 继承 prev
 *
 *   sprites:
 *     - 子里有 <stage/> → 清空
 *     - 子里有 <sprite/> (无 stage) → **替换**
 *     - 无 → 继承 prev
 *
 * 白名单校验在本函数内完成（silent tolerance）：
 *   - bg.scene 不在 manifest → drop，产出 `bg-unknown-scene` degrade
 *   - sprite char 不在 manifest → drop，产出 `sprite-unknown-char`
 *   - sprite mood 不在该 char 的白名单 → drop，产出 `sprite-unknown-mood`
 *   - stage 和 sprite 同时出现 → stage 优先清场，sprite 全部 drop，
 *     产出 `stage-and-sprite-conflict`
 */
export function resolveScene(
  prev: SceneState,
  pending: PendingUnit,
  manifest: ParserManifest,
): ResolvedScene {
  const degrades: DegradeEvent[] = [];

  const nextBg = resolveBackground(prev.background, pending, manifest, degrades);
  const nextSprites = resolveSprites(prev.sprites, pending, manifest, degrades);

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

function resolveSprites(
  prevSprites: ReadonlyArray<SpriteState>,
  pending: PendingUnit,
  manifest: ParserManifest,
  degrades: DegradeEvent[],
): SpriteState[] {
  const hasStage = pending.pendingClearStage;
  const hasSprite = pending.pendingSprites.length > 0;

  if (hasStage && hasSprite) {
    degrades.push({ code: 'stage-and-sprite-conflict' });
    return [];
  }

  if (hasStage) return [];

  if (!hasSprite) return [...prevSprites];  // clone prev (immutable)

  // 替换：对每条 sprite 做白名单校验，失败 drop
  const resolved: SpriteState[] = [];
  for (const sprite of pending.pendingSprites) {
    const verdict = validateSprite(sprite, manifest);
    if (verdict.ok) {
      resolved.push(sprite);
    } else {
      degrades.push(verdict.degrade);
    }
  }
  return resolved;
}

type SpriteVerdict =
  | { ok: true }
  | { ok: false; degrade: DegradeEvent };

function validateSprite(
  sprite: SpriteState,
  manifest: ParserManifest,
): SpriteVerdict {
  if (!manifest.characters.has(sprite.id)) {
    return {
      ok: false,
      degrade: { code: 'sprite-unknown-char', detail: sprite.id },
    };
  }
  const moods = manifest.moodsByChar.get(sprite.id);
  if (!moods || !moods.has(sprite.emotion)) {
    return {
      ok: false,
      degrade: {
        code: 'sprite-unknown-mood',
        detail: `${sprite.id}:${sprite.emotion}`,
      },
    };
  }
  return { ok: true };
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
