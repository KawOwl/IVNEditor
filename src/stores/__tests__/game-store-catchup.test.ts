/**
 * game-store · catch-up 机制
 *
 * 验证 catchUpPending 的状态机：
 *   - 初始化 pending=true
 *   - appendSentence 在 pending=true + 在末端 + 非 scene_change 时 catch-up
 *     触发一次后 pending=false
 *   - 连续新 Sentence 不会重复触发 catch-up
 *   - 玩家 advanceSentence / setVisibleSentenceIndex 把 pending 置回 true
 *   - scene_change 不触发 catch-up
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { useGameStore } from '../game-store';
import type { Sentence, SceneState } from '../../core/types';

const scene: SceneState = { background: null, sprites: [] };

function narration(i: number, text = `s${i}`): Sentence {
  return { kind: 'narration', text, sceneRef: scene, turnNumber: 0, index: i };
}

function sceneChange(i: number): Sentence {
  return { kind: 'scene_change', scene, turnNumber: 0, index: i };
}

describe('game-store · catchUpPending', () => {
  beforeEach(() => {
    useGameStore.getState().reset();
  });

  it('初始 pending=true，vsi=null', () => {
    const s = useGameStore.getState();
    expect(s.catchUpPending).toBe(true);
    expect(s.visibleSentenceIndex).toBeNull();
  });

  it('第一条 Sentence 到达：初始化 vsi=0，pending 置 false', () => {
    useGameStore.getState().appendSentence(narration(0));
    const s = useGameStore.getState();
    expect(s.visibleSentenceIndex).toBe(0);
    expect(s.catchUpPending).toBe(false);
  });

  it('连续新 Sentence：第一次触发 catch-up 到末端，第二次不再前进', () => {
    const { appendSentence } = useGameStore.getState();
    appendSentence(narration(0));    // init → vsi=0, pending=false
    // 玩家主动点一下 → pending=true
    useGameStore.getState().advanceSentence();  // parsedSentences 只有 1 条，vsi 仍在 0
    expect(useGameStore.getState().catchUpPending).toBe(true);

    appendSentence(narration(1));    // pending=true, 玩家在末端 → catch-up 到 vsi=1, pending=false
    expect(useGameStore.getState().visibleSentenceIndex).toBe(1);
    expect(useGameStore.getState().catchUpPending).toBe(false);

    appendSentence(narration(2));    // pending=false → 不动
    expect(useGameStore.getState().visibleSentenceIndex).toBe(1);
    expect(useGameStore.getState().catchUpPending).toBe(false);

    appendSentence(narration(3));    // 仍然 pending=false → 不动
    expect(useGameStore.getState().visibleSentenceIndex).toBe(1);
  });

  it('玩家主动 advanceSentence 把 pending 置回 true', () => {
    const { appendSentence, advanceSentence } = useGameStore.getState();
    appendSentence(narration(0));
    appendSentence(narration(1));
    appendSentence(narration(2));
    // 玩家点过一下后又追加的 Sentence 不会自动前进（pending=false）
    expect(useGameStore.getState().visibleSentenceIndex).toBe(0);
    expect(useGameStore.getState().catchUpPending).toBe(false);

    advanceSentence();
    expect(useGameStore.getState().visibleSentenceIndex).toBe(1);
    expect(useGameStore.getState().catchUpPending).toBe(true);

    appendSentence(narration(3));
    // 玩家现在 vsi=1，不在末端（末端是 2），不 catch-up
    expect(useGameStore.getState().visibleSentenceIndex).toBe(1);

    // 玩家一路点到末端
    advanceSentence();  // vsi=2
    advanceSentence();  // vsi=3（末端）
    expect(useGameStore.getState().visibleSentenceIndex).toBe(3);
    expect(useGameStore.getState().catchUpPending).toBe(true);

    appendSentence(narration(4));  // 又来一条
    // pending=true + 玩家在末端 + 非 scene_change → catch-up
    expect(useGameStore.getState().visibleSentenceIndex).toBe(4);
    expect(useGameStore.getState().catchUpPending).toBe(false);
  });

  it('scene_change 不触发 catch-up', () => {
    const { appendSentence, advanceSentence } = useGameStore.getState();
    appendSentence(narration(0));  // init
    advanceSentence();  // pending=true

    appendSentence(sceneChange(1));
    // scene_change 来了，pending 保持 true，vsi 不变（还是 0）
    expect(useGameStore.getState().visibleSentenceIndex).toBe(0);
    expect(useGameStore.getState().catchUpPending).toBe(true);

    appendSentence(narration(2));
    // 下一条 narration 来了：pending=true + 玩家 vsi=0 是"上一个非 scene_change" →
    // catch-up 到新末尾 vsi=2
    expect(useGameStore.getState().visibleSentenceIndex).toBe(2);
    expect(useGameStore.getState().catchUpPending).toBe(false);
  });

  it('玩家往回翻（vsi < 末端）：新 Sentence 来不打扰', () => {
    const { appendSentence, setVisibleSentenceIndex } = useGameStore.getState();
    appendSentence(narration(0));
    appendSentence(narration(1));
    appendSentence(narration(2));

    // 往回翻到 0
    setVisibleSentenceIndex(0);
    expect(useGameStore.getState().catchUpPending).toBe(true);

    appendSentence(narration(3));
    // 玩家在 0，末端是 3 —— 不在末端，不 catch-up
    expect(useGameStore.getState().visibleSentenceIndex).toBe(0);
    expect(useGameStore.getState().catchUpPending).toBe(true);
  });
});
