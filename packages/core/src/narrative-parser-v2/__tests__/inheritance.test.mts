/**
 * inheritance.ts — 纯函数单测
 *
 * 覆盖 RFC §3.4 视觉状态继承的每种分支 + silent tolerance 降级。
 */

import { describe, it, expect } from 'bun:test';
import type { SceneState } from '#internal/types';
import { resolveScene } from '#internal/narrative-parser-v2/inheritance';
import type { ParserManifest, PendingUnit } from '#internal/narrative-parser-v2/state';
import { emptyPendingUnit } from '#internal/narrative-parser-v2/state';

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

function unitWith(patch: Partial<PendingUnit>): PendingUnit {
  return emptyPendingUnit('dialogue', patch);
}

function dialogueWith(speaker: string, patch: Partial<PendingUnit> = {}): PendingUnit {
  return emptyPendingUnit('dialogue', {
    pf: { speaker },
    rawSpeaker: speaker,
    speakerMissing: false,
    ...patch,
  });
}

describe('resolveScene · 继承', () => {
  it('无子标签 → 完全继承 prev', () => {
    const prev: SceneState = {
      background: 'cafe_interior',
      sprites: [{ id: 'sakuya', emotion: 'smile', position: 'center' }],
    };
    const result = resolveScene(prev, unitWith({}), MANIFEST);
    expect(result.scene).toEqual(prev);
    expect(result.bgChanged).toBe(false);
    expect(result.spritesChanged).toBe(false);
    expect(result.degrades).toHaveLength(0);
  });

  it('空 prev + 空 pending → 空 scene', () => {
    const result = resolveScene(EMPTY_SCENE, unitWith({}), MANIFEST);
    expect(result.scene).toEqual(EMPTY_SCENE);
    expect(result.bgChanged).toBe(false);
  });

  it('pending bg 白名单通过 → 切换', () => {
    const prev: SceneState = { background: 'cafe_interior', sprites: [] };
    const result = resolveScene(
      prev,
      unitWith({ pendingBg: { scene: 'plaza_day' } }),
      MANIFEST,
    );
    expect(result.scene.background).toBe('plaza_day');
    expect(result.bgChanged).toBe(true);
  });

  it('pending bg 未在白名单 → 继承 prev + degrade', () => {
    const prev: SceneState = { background: 'cafe_interior', sprites: [] };
    const result = resolveScene(
      prev,
      unitWith({ pendingBg: { scene: 'alien_planet' } }),
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
      unitWith({ pendingBg: { scene: 'cafe_interior' } }),
      MANIFEST,
    );
    expect(result.bgChanged).toBe(false);
  });
});

describe('resolveScene · sprites', () => {
  it('pending sprites → 替换', () => {
    const prev: SceneState = {
      background: 'cafe_interior',
      sprites: [{ id: 'karina', emotion: 'serious', position: 'left' }],
    };
    const result = resolveScene(
      prev,
      unitWith({
        pendingSprites: [
          { id: 'sakuya', emotion: 'smile', position: 'center' },
        ],
      }),
      MANIFEST,
    );
    expect(result.scene.sprites).toEqual([
      { id: 'sakuya', emotion: 'smile', position: 'center' },
    ]);
    expect(result.spritesChanged).toBe(true);
  });

  it('pending stage → 清空', () => {
    const prev: SceneState = {
      background: 'cafe_interior',
      sprites: [{ id: 'karina', emotion: 'serious', position: 'left' }],
    };
    const result = resolveScene(
      prev,
      unitWith({ pendingClearStage: true }),
      MANIFEST,
    );
    expect(result.scene.sprites).toEqual([]);
    expect(result.spritesChanged).toBe(true);
  });

  it('stage + sprite 冲突 → 按 stage 清场 + degrade', () => {
    const prev: SceneState = {
      background: 'cafe_interior',
      sprites: [{ id: 'karina', emotion: 'serious', position: 'left' }],
    };
    const result = resolveScene(
      prev,
      unitWith({
        pendingClearStage: true,
        pendingSprites: [
          { id: 'sakuya', emotion: 'smile', position: 'center' },
        ],
      }),
      MANIFEST,
    );
    expect(result.scene.sprites).toEqual([]);
    expect(result.degrades).toMatchObject([
      { code: 'stage-and-sprite-conflict' },
    ]);
  });

  it('sprite char 不在白名单 → drop + degrade', () => {
    const result = resolveScene(
      EMPTY_SCENE,
      unitWith({
        pendingSprites: [
          { id: 'mysterious_npc', emotion: 'neutral', position: 'center' },
        ],
      }),
      MANIFEST,
    );
    expect(result.scene.sprites).toEqual([]);
    expect(result.degrades).toMatchObject([
      { code: 'sprite-unknown-char', detail: 'mysterious_npc' },
    ]);
  });

  it('sprite mood 不在该 char 白名单 → drop + degrade', () => {
    const result = resolveScene(
      EMPTY_SCENE,
      unitWith({
        pendingSprites: [
          { id: 'sakuya', emotion: 'furious', position: 'center' },
        ],
      }),
      MANIFEST,
    );
    expect(result.scene.sprites).toEqual([]);
    expect(result.degrades).toMatchObject([
      { code: 'sprite-unknown-mood', detail: 'sakuya:furious' },
    ]);
  });

  it('多个 sprites：部分合法、部分非法 → 保留合法的', () => {
    const result = resolveScene(
      EMPTY_SCENE,
      unitWith({
        pendingSprites: [
          { id: 'sakuya', emotion: 'smile', position: 'center' },
          { id: 'ghost', emotion: 'smile', position: 'left' },
          { id: 'karina', emotion: 'serious', position: 'right' },
        ],
      }),
      MANIFEST,
    );
    expect(result.scene.sprites).toHaveLength(2);
    expect(result.scene.sprites.map((s) => s.id).sort()).toEqual([
      'karina',
      'sakuya',
    ]);
    expect(result.degrades).toHaveLength(1);
    expect(result.degrades[0]?.code).toBe('sprite-unknown-char');
  });

  it('spritesChanged 只看结果是否相同（顺序敏感）', () => {
    const prev: SceneState = {
      background: null,
      sprites: [
        { id: 'sakuya', emotion: 'smile', position: 'center' },
        { id: 'karina', emotion: 'serious', position: 'left' },
      ],
    };
    // 同样两个 sprite，但顺序调换
    const result = resolveScene(
      prev,
      unitWith({
        pendingSprites: [
          { id: 'karina', emotion: 'serious', position: 'left' },
          { id: 'sakuya', emotion: 'smile', position: 'center' },
        ],
      }),
      MANIFEST,
    );
    expect(result.spritesChanged).toBe(true);
  });
});

describe('resolveScene · dialogue speaker 立绘兜底', () => {
  it('空台 + dialogue speaker 是已知角色 + 无 <sprite> → 自动补默认 sprite 在 center', () => {
    const result = resolveScene(EMPTY_SCENE, dialogueWith('karina'), MANIFEST);
    expect(result.scene.sprites).toEqual([
      { id: 'karina', emotion: 'serious', position: 'center' },
    ]);
    expect(result.spritesChanged).toBe(true);
    expect(result.degrades).toMatchObject([
      { code: 'dialogue-speaker-sprite-fallback', detail: 'karina:serious@center' },
    ]);
  });

  it('prev 已含 speaker（继承路径）→ 不补，不 emit', () => {
    const prev: SceneState = {
      background: null,
      sprites: [{ id: 'karina', emotion: 'smile', position: 'left' }],
    };
    const result = resolveScene(prev, dialogueWith('karina'), MANIFEST);
    expect(result.scene.sprites).toEqual(prev.sprites);
    expect(result.spritesChanged).toBe(false);
    expect(result.degrades).toHaveLength(0);
  });

  it('prev 含其他角色 + dialogue speaker 不在 prev → 补到第一个空闲 position', () => {
    const prev: SceneState = {
      background: null,
      sprites: [{ id: 'sakuya', emotion: 'smile', position: 'center' }],
    };
    const result = resolveScene(prev, dialogueWith('karina'), MANIFEST);
    // center 已被 sakuya 占，karina 落到 left（VALID_POSITIONS 第二个）
    expect(result.scene.sprites).toEqual([
      { id: 'sakuya', emotion: 'smile', position: 'center' },
      { id: 'karina', emotion: 'serious', position: 'left' },
    ]);
    expect(result.degrades).toMatchObject([
      { code: 'dialogue-speaker-sprite-fallback', detail: 'karina:serious@left' },
    ]);
  });

  it('LLM <sprite> 写了配角但漏 speaker → 在替换之上仍补 speaker', () => {
    const result = resolveScene(
      EMPTY_SCENE,
      dialogueWith('karina', {
        pendingSprites: [{ id: 'sakuya', emotion: 'smile', position: 'center' }],
      }),
      MANIFEST,
    );
    expect(result.scene.sprites).toEqual([
      { id: 'sakuya', emotion: 'smile', position: 'center' },
      { id: 'karina', emotion: 'serious', position: 'left' },
    ]);
  });

  it('<stage/> 清场后没补 sprite → fallback 补 speaker 到 center', () => {
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
  });

  it('narration（非 dialogue）→ 不触发兜底', () => {
    const result = resolveScene(EMPTY_SCENE, emptyPendingUnit('narration'), MANIFEST);
    expect(result.scene.sprites).toEqual([]);
    expect(result.degrades).toHaveLength(0);
  });

  it('speakerMissing dialogue（已降级 narration）→ 不触发兜底', () => {
    const unit = emptyPendingUnit('dialogue', { speakerMissing: true });
    const result = resolveScene(EMPTY_SCENE, unit, MANIFEST);
    expect(result.scene.sprites).toEqual([]);
    expect(result.degrades).toHaveLength(0);
  });

  it('ad-hoc speaker（__npc__保安）→ 不触发兜底', () => {
    const result = resolveScene(EMPTY_SCENE, dialogueWith('__npc__保安'), MANIFEST);
    expect(result.scene.sprites).toEqual([]);
    expect(result.degrades).toHaveLength(0);
  });

  it('speaker 不在白名单（杜撰）→ 不触发兜底', () => {
    const result = resolveScene(EMPTY_SCENE, dialogueWith('mystery_man'), MANIFEST);
    expect(result.scene.sprites).toEqual([]);
    expect(result.degrades).toHaveLength(0);
  });

  it('speaker 在白名单但 manifest 没给 sprite → 不触发兜底', () => {
    const manifestNoSprites: ParserManifest = {
      characters: new Set(['voice_only']),
      moodsByChar: new Map([['voice_only', new Set()]]),
      defaultMoodByChar: new Map(), // 没条目
      backgrounds: new Set(),
    };
    const result = resolveScene(EMPTY_SCENE, dialogueWith('voice_only'), manifestNoSprites);
    expect(result.scene.sprites).toEqual([]);
    expect(result.degrades).toHaveLength(0);
  });

  it('三个 position 全占满 → emit no-position event 且不补', () => {
    const prev: SceneState = {
      background: null,
      sprites: [
        { id: 'sakuya', emotion: 'smile', position: 'left' },
        { id: 'mc', emotion: 'neutral', position: 'center' },
        { id: 'karina', emotion: 'smile', position: 'right' },
      ],
    };
    // 加一个新角色 dialogue 但他没有立绘空位
    const manifestPlus: ParserManifest = {
      ...MANIFEST,
      characters: new Set([...MANIFEST.characters, 'extra']),
      moodsByChar: new Map([
        ...MANIFEST.moodsByChar.entries(),
        ['extra', new Set(['neutral'])],
      ]),
      defaultMoodByChar: new Map([
        ...MANIFEST.defaultMoodByChar.entries(),
        ['extra', 'neutral'],
      ]),
    };
    const result = resolveScene(prev, dialogueWith('extra'), manifestPlus);
    expect(result.scene.sprites).toEqual(prev.sprites);
    expect(result.degrades).toMatchObject([
      { code: 'dialogue-speaker-sprite-fallback', detail: 'extra:no-position' },
    ]);
  });
});
