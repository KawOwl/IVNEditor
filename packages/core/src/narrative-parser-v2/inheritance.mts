/**
 * Narrative Parser v2 — 视觉状态继承推导
 *
 * RFC §3.4 的 TypeScript 编码。**纯函数**：接一个 prev scene 和 pending 的
 * 视觉子标签，产出 resolved scene + change flags + degrades。
 *
 * 不 mutate 输入。不做 IO。不依赖 htmlparser2。
 */

import type { SceneState, SpriteState } from '#internal/types';
import type { PendingUnit, ParserManifest, DegradeEvent } from '#internal/narrative-parser-v2/state';
import { isAdhocSpeaker } from '#internal/narrative-parser-v2/tag-schema';

/**
 * Speaker fallback 注入新 sprite 时的 position 优先顺序：center 最自然
 * （单角色对话默认居中），其次 left / right。和 tag-schema 的 VALID_POSITIONS
 * 不同——后者按属性值字母序声明，这里按"美术意图"优先级。
 */
const FALLBACK_POSITION_PREFERENCE: ReadonlyArray<'center' | 'left' | 'right'> = [
  'center',
  'left',
  'right',
];

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
 *
 * 上述完成后还有一层 dialogue speaker 兜底：dialogue 容器结束时如果 speaker
 * 是 manifest 已知角色但当前台上没有该 speaker 的立绘（无论是 LLM 没写
 * `<sprite>`、清场后没补、或者只放了配角的立绘），自动在第一个空闲位置补
 * 一个 manifest 里该角色的默认 sprite，并 emit `dialogue-speaker-sprite-fallback`
 * 中性事件供 trace 量化。
 */
export function resolveScene(
  prev: SceneState,
  pending: PendingUnit,
  manifest: ParserManifest,
): ResolvedScene {
  const degrades: DegradeEvent[] = [];

  const nextBg = resolveBackground(prev.background, pending, manifest, degrades);
  const baseSprites = resolveSprites(prev.sprites, pending, manifest, degrades);
  const nextSprites = applySpeakerSpriteFallback(baseSprites, pending, manifest, degrades);

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
// Dialogue speaker 立绘兜底
// ============================================================================

/**
 * 给 `<dialogue>` 兜底：speaker 是 manifest 已知角色但台上没有 speaker 的
 * 立绘时，自动在第一个空闲位置补一个 manifest 默认 sprite。
 *
 * 触发条件（全部满足）：
 *   1. unit.kind === 'dialogue' 且 speaker 完整（speakerMissing=false）
 *   2. speaker 不是 ad-hoc（`__npc__保安`、`__npc__你` 等都没立绘）
 *   3. speaker 在 manifest.characters 白名单内
 *   4. manifest 给该 speaker 配过至少一个 sprite（defaultMoodByChar 有 key）
 *   5. 当前 resolved sprites 里没有任何条目 id === speaker
 *   6. 三个 position（center / left / right）至少有一个空闲
 *
 * 满足 1-5 但 6 不满足（台上 3 个角色全占满）→ 跳过，emit
 * `dialogue-speaker-sprite-fallback` 但保留 detail 注明 'no-position'，
 * UI 行为和原来一致（speaker 不上台），但 trace 能区分。
 *
 * Position 选择：依次尝试 center → left → right，第一个空闲就用。
 * center 优先因为它是单角色对话最自然的位置。
 *
 * 注意：这不是降级，是补全。speaker 已经能正常说话，UI 只是缺立绘；
 * 兜底之后玩家看到的才是符合 VN 直觉的画面。
 */
function applySpeakerSpriteFallback(
  resolved: SpriteState[],
  pending: PendingUnit,
  manifest: ParserManifest,
  degrades: DegradeEvent[],
): SpriteState[] {
  if (pending.kind !== 'dialogue') return resolved;
  if (pending.speakerMissing) return resolved;
  const speaker = pending.pf?.speaker;
  if (!speaker) return resolved;
  if (isAdhocSpeaker(speaker)) return resolved;
  if (!manifest.characters.has(speaker)) return resolved;
  const defaultMood = manifest.defaultMoodByChar.get(speaker);
  if (!defaultMood) return resolved;
  if (resolved.some((s) => s.id === speaker)) return resolved;

  const used = new Set(resolved.map((s) => s.position).filter(Boolean));
  const free = FALLBACK_POSITION_PREFERENCE.find((p) => !used.has(p));
  if (!free) {
    degrades.push({
      code: 'dialogue-speaker-sprite-fallback',
      detail: `${speaker}:no-position`,
    });
    return resolved;
  }

  degrades.push({
    code: 'dialogue-speaker-sprite-fallback',
    detail: `${speaker}:${defaultMood}@${free}`,
  });
  return [...resolved, { id: speaker, emotion: defaultMood, position: free }];
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
