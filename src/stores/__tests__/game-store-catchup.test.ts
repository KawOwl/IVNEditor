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
import { useGameStore } from '../game-store';
import type { Sentence, SceneState } from '../../core/types';

const scene: SceneState = { background: null, sprites: [] };

function narration(i: number, text = `s${i}`, sceneRef: SceneState = scene): Sentence {
  return { kind: 'narration', text, sceneRef, turnNumber: 0, index: i };
}

function sceneChange(i: number, s: SceneState = scene, transition?: 'fade' | 'cut' | 'dissolve'): Sentence {
  return { kind: 'scene_change', scene: s, transition, turnNumber: 0, index: i };
}

function signalInput(i: number, hint = 'pick one', choices = ['A', 'B'], sceneRef: SceneState = scene): Sentence {
  return { kind: 'signal_input', hint, choices, sceneRef, turnNumber: 0, index: i };
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

/**
 * V.4（RFC §11 V.4 前端消费更新）：appendSentence 从 Sentence 派生 currentScene。
 *
 * v2 声明式 IR 下 scenePatchEmitter=null，不再 emit mid-session scene-change WS。
 * 所以 store 的 currentScene 必须靠 Sentence 自己带的 sceneRef 推起来。
 * 这套 test 覆盖：narration / dialogue / signal_input / player_input / scene_change
 * 都能正确让 store.currentScene 对齐 Sentence。
 */
describe('game-store · currentScene 从 Sentence 派生（V.4）', () => {
  beforeEach(() => {
    useGameStore.getState().reset();
  });

  const classroom: SceneState = {
    background: { backgroundId: 'classroom' },
    sprites: [],
  };
  const hallway: SceneState = {
    background: { backgroundId: 'hallway' },
    sprites: [],
  };

  it('narration.sceneRef 驱动 currentScene（v2 无 scene-change WS 路径）', () => {
    useGameStore.getState().appendSentence(narration(0, 's0', classroom));
    expect(useGameStore.getState().currentScene).toEqual(classroom);
  });

  it('连续 narration sceneRef 变化 → currentScene 跟着变', () => {
    const { appendSentence } = useGameStore.getState();
    appendSentence(narration(0, 's0', classroom));
    expect(useGameStore.getState().currentScene).toEqual(classroom);

    appendSentence(narration(1, 's1', hallway));
    expect(useGameStore.getState().currentScene).toEqual(hallway);
  });

  it('dialogue.sceneRef 也驱动 currentScene', () => {
    const dialogueSentence: Sentence = {
      kind: 'dialogue',
      text: 'hi',
      pf: { speaker: 'sakuya' },
      sceneRef: hallway,
      turnNumber: 0,
      index: 0,
    };
    useGameStore.getState().appendSentence(dialogueSentence);
    expect(useGameStore.getState().currentScene).toEqual(hallway);
  });

  it('scene_change.scene + transition 驱动 currentScene + lastSceneTransition（v1 path）', () => {
    useGameStore.getState().appendSentence(sceneChange(0, hallway, 'cut'));
    const s = useGameStore.getState();
    expect(s.currentScene).toEqual(hallway);
    expect(s.lastSceneTransition).toBe('cut');
  });

  it('scene_change 不带 transition → 保留既有 lastSceneTransition', () => {
    const { appendSentence } = useGameStore.getState();
    // 先用 scene_change 置 dissolve
    appendSentence(sceneChange(0, classroom, 'dissolve'));
    expect(useGameStore.getState().lastSceneTransition).toBe('dissolve');
    // 再来一个无 transition 的 scene_change → lastSceneTransition 应保持 dissolve
    appendSentence(sceneChange(1, hallway));
    expect(useGameStore.getState().lastSceneTransition).toBe('dissolve');
    expect(useGameStore.getState().currentScene).toEqual(hallway);
  });

  it('signal_input / player_input.sceneRef 也驱动 currentScene', () => {
    const { appendSentence } = useGameStore.getState();
    appendSentence(signalInput(0, 'pick', ['A', 'B'], classroom));
    expect(useGameStore.getState().currentScene).toEqual(classroom);

    const playerInput: Sentence = {
      kind: 'player_input',
      text: 'A',
      selectedIndex: 0,
      sceneRef: hallway,
      turnNumber: 0,
      index: 1,
    };
    appendSentence(playerInput);
    expect(useGameStore.getState().currentScene).toEqual(hallway);
  });

  it('首次 append（vsi 初始化分支）也派生 currentScene', () => {
    // reset 后 currentScene 应为空初值
    expect(useGameStore.getState().currentScene).toEqual({ background: null, sprites: [] });
    useGameStore.getState().appendSentence(narration(0, 's0', classroom));
    // 第一次 append 走 vsi===null 的初始化分支，也要更新 scene
    const s = useGameStore.getState();
    expect(s.visibleSentenceIndex).toBe(0);
    expect(s.currentScene).toEqual(classroom);
  });
});
