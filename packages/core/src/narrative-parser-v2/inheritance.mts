/**
 * Narrative Parser v2 — 视觉状态推导（V.14 turn 级生命周期版）
 *
 * 规则（V.14 修正 V.10 的 unit 级生命周期理解错误）：
 *   - **dialogue 单元**：sprites = [speaker 立绘 at center]
 *     - 已知 speaker（manifest.characters 含该 id）→ 用该 character 的 default
 *       mood；缺 default mood（作者还没上传 sprite 资产）→ emotion 空串，UI
 *       占位卡片兜底渲染。
 *     - ad-hoc speaker（`__npc__保安` 等）→ 映射到 reserved character id
 *       `__npc__` 查找；作者在编辑器添加了 `__npc__` 角色就触发，没添加则空台。
 *     - 不在白名单（杜撰角色）→ 空台（立绘换不了对应"未知人物在说话"）。
 *   - **非 dialogue 单元**（narration / speakerMissing dialogue 已降级）→
 *     **继承 prev.sprites**。turn 内 dialogue (A) → narration → narration → ...
 *     期间 A 立绘全程保留，直到下一个 dialogue (B) 来时换人。
 *   - 忽略 `<sprite>` / `<stage/>` 子标签（仍被 parser 识别但对最终 sceneRef
 *     不产生影响；V.10 起的 LLM 协议简化）。
 *
 * Turn 边界清空在两处：
 *   1. `game-session.runReceivePhase` 让 player_input.sceneRef.sprites=[]
 *      （V.13），玩家输入气泡渲染时立绘退场。
 *   2. `game-session.runGenerateTurn` 传给 reducer 的 initialScene.sprites=[]
 *      （V.14），让本 turn 第一个 unit 是 narration 时不继承上 turn 最后立绘。
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
  const nextSprites = resolveSpeakerSprite(pending, manifest, prev.sprites);

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
 * V.14 立绘规则：dialogue 换 speaker 立绘 / 非 dialogue 继承 prev。
 *
 * Dialogue 单元：尝试 emit speaker 立绘。
 *   - lookupId = ad-hoc 映射后的 character id（`__npc__保安` → `__npc__`）
 *   - lookupId 不在 manifest.characters 白名单（杜撰 / ad-hoc 但作者没配
 *     `__npc__`）→ 清空（立绘换不了，视觉上消失对应"未知人物在说话"）
 *   - lookupId 在白名单但 manifest 没给 sprite 资产 → emotion 空串，UI 占位卡
 *   - 已知 + 配过 sprite → emit [{id, defaultMood, center}]
 *
 * 非 dialogue 单元（narration / speakerMissing dialogue 降级 / scratch）→
 * 继承 prev.sprites。turn 内 dialogue → narration 后立绘保留，直到下一个
 * dialogue 换人。Turn 边界清空靠 game-session.runGenerateTurn 把 reducer
 * initialScene.sprites=[]（V.14）+ player_input.sceneRef.sprites=[]（V.13）
 * 双重保证。
 */
function resolveSpeakerSprite(
  pending: PendingUnit,
  manifest: ParserManifest,
  prevSprites: ReadonlyArray<SpriteState>,
): SpriteState[] {
  // 非 dialogue（含 speakerMissing 已降级 narration）→ 继承 prev
  if (pending.kind !== 'dialogue' || pending.speakerMissing) {
    return [...prevSprites];
  }
  const speaker = pending.pf?.speaker;
  if (!speaker) return [...prevSprites];
  const lookupId = isAdhocSpeaker(speaker) ? NPC_RESERVED_CHARACTER_ID : speaker;
  // 不在白名单（杜撰 / ad-hoc 但 __npc__ 没配）→ 清空，对应"未知人物在说话"
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
