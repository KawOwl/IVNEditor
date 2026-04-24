/**
 * inheritance.ts — 纯函数单测
 *
 * 覆盖 RFC §3.4 视觉状态继承的每种分支 + silent tolerance 降级。
 */

import { describe, it, expect } from 'bun:test';
import type { SceneState } from '../../types';
import { resolveScene } from '../inheritance';
import type { ParserManifest, PendingUnit } from '../state';
import { emptyPendingUnit } from '../state';

const MANIFEST: ParserManifest = {
  characters: new Set(['sakuya', 'karina', 'mc']),
  moodsByChar: new Map([
    ['sakuya', new Set(['neutral', 'smile', 'worried'])],
    ['karina', new Set(['serious', 'smile'])],
    ['mc', new Set(['neutral'])],
  ]),
  backgrounds: new Set(['cafe_interior', 'plaza_day', 'street_shadow']),
};

const EMPTY_SCENE: SceneState = { background: null, sprites: [] };

function unitWith(patch: Partial<PendingUnit>): PendingUnit {
  return emptyPendingUnit('dialogue', patch);
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
