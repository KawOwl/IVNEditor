/**
 * inheritance.ts — 纯函数单测（V.14 turn 级生命周期版立绘规则）
 *
 * 当前规则：
 *   - dialogue 单元 → speaker 立绘 at center（ad-hoc 走 `__npc__` reserved id）
 *   - 非 dialogue 单元（narration / speakerMissing 已降级）→ 继承 prev.sprites
 *   - 杜撰 speaker（白名单外）→ 清空，对应"未知人物在说话"
 *   - 忽略 `<sprite>` / `<stage/>` 子标签
 *
 * Turn 边界清空在 game-session 层做（V.13 player_input.sceneRef.sprites=[]
 * + V.14 reducer initialScene.sprites=[]），不在 inheritance.mts 里。
 *
 * 背景规则不变。
 */

import { describe, it, expect } from 'bun:test';
import type { SceneState } from '#internal/types';
import { resolveScene } from '#internal/narrative-parser-v2/inheritance';
import type { ParserManifest, PendingUnit } from '#internal/narrative-parser-v2/state';
import { emptyPendingUnit } from '#internal/narrative-parser-v2/state';
import { NPC_RESERVED_CHARACTER_ID } from '#internal/narrative-parser-v2/tag-schema';

const MANIFEST: ParserManifest = {
  characters: new Set(['sakuya', 'karina', 'mc']),
  moodsByChar: new Map([
    ['sakuya', new Set(['neutral', 'smile', 'worried'])],
    ['karina', new Set(['serious', 'smile'])],
    ['mc', new Set(['neutral'])],
  ]),
  defaultMoodByChar: new Map([
    ['sakuya', 'neutral'],
    ['karina', 'serious'],
    ['mc', 'neutral'],
  ]),
  backgrounds: new Set(['cafe_interior', 'plaza_day', 'street_shadow']),
};

const EMPTY_SCENE: SceneState = { background: null, sprites: [] };

function dialogueWith(speaker: string, patch: Partial<PendingUnit> = {}): PendingUnit {
  return emptyPendingUnit('dialogue', {
    pf: { speaker },
    rawSpeaker: speaker,
    speakerMissing: false,
    ...patch,
  });
}

describe('resolveScene · 背景规则', () => {
  it('无 pendingBg → 继承 prev', () => {
    const prev: SceneState = {
      background: 'cafe_interior',
      sprites: [],
    };
    const result = resolveScene(prev, emptyPendingUnit('narration'), MANIFEST);
    expect(result.scene.background).toBe('cafe_interior');
    expect(result.bgChanged).toBe(false);
    expect(result.degrades).toHaveLength(0);
  });

  it('pending bg 白名单通过 → 切换', () => {
    const prev: SceneState = { background: 'cafe_interior', sprites: [] };
    const result = resolveScene(
      prev,
      emptyPendingUnit('narration', { pendingBg: { scene: 'plaza_day' } }),
      MANIFEST,
    );
    expect(result.scene.background).toBe('plaza_day');
    expect(result.bgChanged).toBe(true);
  });

  it('pending bg 未在白名单 → 继承 prev + degrade', () => {
    const prev: SceneState = { background: 'cafe_interior', sprites: [] };
    const result = resolveScene(
      prev,
      emptyPendingUnit('narration', { pendingBg: { scene: 'alien_planet' } }),
      MANIFEST,
    );
    expect(result.scene.background).toBe('cafe_interior');
    expect(result.bgChanged).toBe(false);
    expect(result.degrades).toMatchObject([
      { code: 'bg-unknown-scene', detail: 'alien_planet' },
    ]);
  });

  it('相同 bg → bgChanged=false', () => {
    const prev: SceneState = { background: 'cafe_interior', sprites: [] };
    const result = resolveScene(
      prev,
      emptyPendingUnit('narration', { pendingBg: { scene: 'cafe_interior' } }),
      MANIFEST,
    );
    expect(result.bgChanged).toBe(false);
  });
});

describe('resolveScene · V.14 立绘规则（dialogue 换人 / narration 继承）', () => {
  it('dialogue + 已知 speaker → sprites = [speaker 默认 sprite at center]', () => {
    const result = resolveScene(EMPTY_SCENE, dialogueWith('karina'), MANIFEST);
    expect(result.scene.sprites).toEqual([
      { id: 'karina', emotion: 'serious', position: 'center' },
    ]);
    expect(result.spritesChanged).toBe(true);
    expect(result.degrades).toHaveLength(0);
  });

  it('narration → 继承 prev.sprites（立绘保留，不退场）', () => {
    const prev: SceneState = {
      background: null,
      sprites: [{ id: 'karina', emotion: 'serious', position: 'center' }],
    };
    const result = resolveScene(prev, emptyPendingUnit('narration'), MANIFEST);
    expect(result.scene.sprites).toEqual([
      { id: 'karina', emotion: 'serious', position: 'center' },
    ]);
    expect(result.spritesChanged).toBe(false);
  });

  it('narration on empty stage → sprites 仍空', () => {
    const result = resolveScene(EMPTY_SCENE, emptyPendingUnit('narration'), MANIFEST);
    expect(result.scene.sprites).toEqual([]);
    expect(result.spritesChanged).toBe(false);
  });

  it('dialogue (A) → narration → narration → dialogue (A) 链：A 立绘全程保留', () => {
    const step1 = resolveScene(EMPTY_SCENE, dialogueWith('sakuya'), MANIFEST);
    const sakuya = { id: 'sakuya', emotion: 'neutral', position: 'center' as const };
    expect(step1.scene.sprites).toEqual([sakuya]);

    const step2 = resolveScene(step1.scene, emptyPendingUnit('narration'), MANIFEST);
    expect(step2.scene.sprites).toEqual([sakuya]);
    expect(step2.spritesChanged).toBe(false);

    const step3 = resolveScene(step2.scene, emptyPendingUnit('narration'), MANIFEST);
    expect(step3.scene.sprites).toEqual([sakuya]);

    const step4 = resolveScene(step3.scene, dialogueWith('sakuya'), MANIFEST);
    expect(step4.scene.sprites).toEqual([sakuya]);
    expect(step4.spritesChanged).toBe(false);
  });

  it('dialogue (A) → narration → dialogue (B)：narration 期间保留 A，B 来时换人', () => {
    const step1 = resolveScene(EMPTY_SCENE, dialogueWith('sakuya'), MANIFEST);
    const step2 = resolveScene(step1.scene, emptyPendingUnit('narration'), MANIFEST);
    expect(step2.scene.sprites).toEqual([
      { id: 'sakuya', emotion: 'neutral', position: 'center' },
    ]);
    const step3 = resolveScene(step2.scene, dialogueWith('karina'), MANIFEST);
    expect(step3.scene.sprites).toEqual([
      { id: 'karina', emotion: 'serious', position: 'center' },
    ]);
    expect(step3.spritesChanged).toBe(true);
  });

  it('dialogue 切 speaker → 立绘换人（不并存）', () => {
    const step1 = resolveScene(EMPTY_SCENE, dialogueWith('sakuya'), MANIFEST);
    const step2 = resolveScene(step1.scene, dialogueWith('karina'), MANIFEST);
    expect(step2.scene.sprites).toEqual([
      { id: 'karina', emotion: 'serious', position: 'center' },
    ]);
    expect(step2.spritesChanged).toBe(true);
  });

  it('dialogue 同一 speaker 连续 → spritesChanged=false', () => {
    const step1 = resolveScene(EMPTY_SCENE, dialogueWith('sakuya'), MANIFEST);
    const step2 = resolveScene(step1.scene, dialogueWith('sakuya'), MANIFEST);
    expect(step2.scene.sprites).toEqual([
      { id: 'sakuya', emotion: 'neutral', position: 'center' },
    ]);
    expect(step2.spritesChanged).toBe(false);
  });

  it('speakerMissing dialogue（reducer 已降级 narration）→ 继承 prev', () => {
    const prev: SceneState = {
      background: null,
      sprites: [{ id: 'sakuya', emotion: 'neutral', position: 'center' }],
    };
    const unit = emptyPendingUnit('dialogue', { speakerMissing: true });
    const result = resolveScene(prev, unit, MANIFEST);
    expect(result.scene.sprites).toEqual([
      { id: 'sakuya', emotion: 'neutral', position: 'center' },
    ]);
    expect(result.spritesChanged).toBe(false);
    expect(result.degrades).toHaveLength(0);
  });

  it('ad-hoc speaker（__npc__保安）+ 作者没配 __npc__ → 清空（白名单外）', () => {
    const prev: SceneState = {
      background: null,
      sprites: [{ id: 'sakuya', emotion: 'neutral', position: 'center' }],
    };
    const result = resolveScene(prev, dialogueWith('__npc__保安'), MANIFEST);
    expect(result.scene.sprites).toEqual([]);
    expect(result.spritesChanged).toBe(true);
    expect(result.degrades).toHaveLength(0);
  });

  it('ad-hoc speaker（__npc__保安）+ 作者配了 __npc__ + 配过 sprite → 用 __npc__ 立绘', () => {
    const manifestWithNpc: ParserManifest = {
      characters: new Set([NPC_RESERVED_CHARACTER_ID]),
      moodsByChar: new Map([[NPC_RESERVED_CHARACTER_ID, new Set(['default'])]]),
      defaultMoodByChar: new Map([[NPC_RESERVED_CHARACTER_ID, 'default']]),
      backgrounds: new Set(),
    };
    const result = resolveScene(EMPTY_SCENE, dialogueWith('__npc__保安'), manifestWithNpc);
    expect(result.scene.sprites).toEqual([
      { id: NPC_RESERVED_CHARACTER_ID, emotion: 'default', position: 'center' },
    ]);
    expect(result.degrades).toHaveLength(0);
  });

  it('ad-hoc speaker + 作者配了 __npc__ 但没上传 sprite → emit 占位 sprite（emotion 空串）', () => {
    const manifestNpcNoSprite: ParserManifest = {
      characters: new Set([NPC_RESERVED_CHARACTER_ID]),
      moodsByChar: new Map([[NPC_RESERVED_CHARACTER_ID, new Set()]]),
      defaultMoodByChar: new Map(),
      backgrounds: new Set(),
    };
    const result = resolveScene(EMPTY_SCENE, dialogueWith('__npc__老板'), manifestNpcNoSprite);
    expect(result.scene.sprites).toEqual([
      { id: NPC_RESERVED_CHARACTER_ID, emotion: '', position: 'center' },
    ]);
    expect(result.degrades).toHaveLength(0);
  });

  it('多个不同 ad-hoc speaker（保安 / 老板）共用同一 __npc__ 立绘条目', () => {
    const manifestWithNpc: ParserManifest = {
      characters: new Set([NPC_RESERVED_CHARACTER_ID]),
      moodsByChar: new Map([[NPC_RESERVED_CHARACTER_ID, new Set(['default'])]]),
      defaultMoodByChar: new Map([[NPC_RESERVED_CHARACTER_ID, 'default']]),
      backgrounds: new Set(),
    };
    const step1 = resolveScene(EMPTY_SCENE, dialogueWith('__npc__保安'), manifestWithNpc);
    const step2 = resolveScene(step1.scene, dialogueWith('__npc__老板'), manifestWithNpc);
    expect(step2.scene.sprites).toEqual([
      { id: NPC_RESERVED_CHARACTER_ID, emotion: 'default', position: 'center' },
    ]);
    expect(step2.spritesChanged).toBe(false);
  });

  it('裸 __npc__（前缀本身作为 speaker）走同一映射', () => {
    const manifestWithNpc: ParserManifest = {
      characters: new Set([NPC_RESERVED_CHARACTER_ID]),
      moodsByChar: new Map([[NPC_RESERVED_CHARACTER_ID, new Set(['default'])]]),
      defaultMoodByChar: new Map([[NPC_RESERVED_CHARACTER_ID, 'default']]),
      backgrounds: new Set(),
    };
    const result = resolveScene(EMPTY_SCENE, dialogueWith('__npc__'), manifestWithNpc);
    expect(result.scene.sprites).toEqual([
      { id: NPC_RESERVED_CHARACTER_ID, emotion: 'default', position: 'center' },
    ]);
  });

  it('speaker 不在白名单（杜撰）→ 清空（不继承，对应"未知人物在说话"）', () => {
    const prev: SceneState = {
      background: null,
      sprites: [{ id: 'sakuya', emotion: 'neutral', position: 'center' }],
    };
    const result = resolveScene(prev, dialogueWith('mystery_man'), MANIFEST);
    expect(result.scene.sprites).toEqual([]);
    expect(result.spritesChanged).toBe(true);
    expect(result.degrades).toHaveLength(0);
  });

  it('已知 speaker 但 manifest 没给 sprite → emit 占位 sprite（emotion 空串）', () => {
    const manifestNoSprites: ParserManifest = {
      characters: new Set(['voice_only']),
      moodsByChar: new Map([['voice_only', new Set()]]),
      defaultMoodByChar: new Map(),
      backgrounds: new Set(),
    };
    const result = resolveScene(EMPTY_SCENE, dialogueWith('voice_only'), manifestNoSprites);
    expect(result.scene.sprites).toEqual([
      { id: 'voice_only', emotion: '', position: 'center' },
    ]);
    expect(result.degrades).toHaveLength(0);
  });

  it('忽略 <sprite> 子标签：pendingSprites 不影响输出', () => {
    const result = resolveScene(
      EMPTY_SCENE,
      dialogueWith('karina', {
        pendingSprites: [
          { id: 'sakuya', emotion: 'smile', position: 'right' },
        ],
      }),
      MANIFEST,
    );
    expect(result.scene.sprites).toEqual([
      { id: 'karina', emotion: 'serious', position: 'center' },
    ]);
    expect(result.degrades).toHaveLength(0);
  });

  it('忽略 <stage/>：pendingClearStage 不影响输出', () => {
    const prev: SceneState = {
      background: null,
      sprites: [{ id: 'sakuya', emotion: 'smile', position: 'center' }],
    };
    const result = resolveScene(
      prev,
      dialogueWith('karina', { pendingClearStage: true }),
      MANIFEST,
    );
    expect(result.scene.sprites).toEqual([
      { id: 'karina', emotion: 'serious', position: 'center' },
    ]);
    expect(result.degrades).toHaveLength(0);
  });

  it('narration 上的 <sprite> 标签也被忽略，prev 立绘继续保留', () => {
    const prev: SceneState = {
      background: null,
      sprites: [{ id: 'karina', emotion: 'serious', position: 'center' }],
    };
    const result = resolveScene(
      prev,
      emptyPendingUnit('narration', {
        pendingSprites: [
          { id: 'sakuya', emotion: 'smile', position: 'center' },
        ],
      }),
      MANIFEST,
    );
    expect(result.scene.sprites).toEqual([
      { id: 'karina', emotion: 'serious', position: 'center' },
    ]);
    expect(result.degrades).toHaveLength(0);
  });

  it('prev 含其他角色 + 新 dialogue speaker → prev 立绘被彻底替换为 speaker only', () => {
    const prev: SceneState = {
      background: null,
      sprites: [
        { id: 'sakuya', emotion: 'smile', position: 'left' },
        { id: 'mc', emotion: 'neutral', position: 'right' },
      ],
    };
    const result = resolveScene(prev, dialogueWith('karina'), MANIFEST);
    expect(result.scene.sprites).toEqual([
      { id: 'karina', emotion: 'serious', position: 'center' },
    ]);
    expect(result.spritesChanged).toBe(true);
  });
});
