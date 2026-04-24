/**
 * game-store · 推进行为
 *
 * 2026-04-23：catchUpPending 自动前进已关（见 game-store.ts appendSentence 注释）。
 *   - 初始化（vsi null → 0）仍然发生 —— 开局必须给玩家看到第一条
 *   - 之后任何新 Sentence 到达都**不自动推进**，玩家必须点击
 *   - pending 字段、re-arm 逻辑保留，为未来开回做准备
 *
 * 测试的关注点从"自动推进时机"切到"手动推进行为 + 跳过型 Sentence 处理"。
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { useGameStore } from '#internal/stores/game-store';
import type { Sentence, SceneState } from '@ivn/core/types';

const scene: SceneState = { background: null, sprites: [] };

function narration(i: number, text = `s${i}`): Sentence {
  return { kind: 'narration', text, sceneRef: scene, turnNumber: 0, index: i };
}

function sceneChange(i: number): Sentence {
  return { kind: 'scene_change', scene, turnNumber: 0, index: i };
}

function signalInput(i: number, hint = 'pick one', choices = ['A', 'B']): Sentence {
  return { kind: 'signal_input', hint, choices, sceneRef: scene, turnNumber: 0, index: i };
}

describe('game-store · 推进行为（自动前进已关）', () => {
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

  it('后续新 Sentence 到达：vsi 不自动前进（关掉 catch-up）', () => {
    const { appendSentence } = useGameStore.getState();
    appendSentence(narration(0));    // init → vsi=0
    appendSentence(narration(1));    // 不动
    appendSentence(narration(2));    // 不动
    expect(useGameStore.getState().visibleSentenceIndex).toBe(0);
  });

  it('advance 跨过 scene_change / signal_input', () => {
    const { appendSentence, advanceSentence } = useGameStore.getState();
    appendSentence(narration(0));
    appendSentence(sceneChange(1));
    appendSentence(narration(2));

    // 玩家在 vsi=0 点击 → 应该跳过 scene_change 直达 narration(2)
    advanceSentence();
    expect(useGameStore.getState().visibleSentenceIndex).toBe(2);
  });

  it('advance 跨过 signal_input（同 scene_change）', () => {
    const { appendSentence, advanceSentence } = useGameStore.getState();
    appendSentence(narration(0));
    appendSentence(signalInput(1));
    appendSentence(narration(2));

    advanceSentence();
    expect(useGameStore.getState().visibleSentenceIndex).toBe(2);
  });

  it('advance 到末尾不越界', () => {
    const { appendSentence, advanceSentence } = useGameStore.getState();
    appendSentence(narration(0));
    appendSentence(narration(1));

    advanceSentence(); // vsi=1
    advanceSentence(); // 已在末尾，不越界
    expect(useGameStore.getState().visibleSentenceIndex).toBe(1);
  });

  it('setVisibleSentenceIndex 可以往回翻', () => {
    const { appendSentence, setVisibleSentenceIndex } = useGameStore.getState();
    appendSentence(narration(0));
    appendSentence(narration(1));
    appendSentence(narration(2));

    setVisibleSentenceIndex(0);
    expect(useGameStore.getState().visibleSentenceIndex).toBe(0);

    // 新 Sentence 到达不打扰（已关自动前进 + 玩家回翻都不动）
    appendSentence(narration(3));
    expect(useGameStore.getState().visibleSentenceIndex).toBe(0);
  });

  it('advance 在连续 scene_change 后停在最后可读条目', () => {
    const { appendSentence, advanceSentence } = useGameStore.getState();
    appendSentence(narration(0));
    appendSentence(sceneChange(1));
    appendSentence(sceneChange(2));

    // 玩家点推进：没有更多可读 → 停在 vsi=0（不滑到 length）
    advanceSentence();
    expect(useGameStore.getState().visibleSentenceIndex).toBe(0);
  });
});
