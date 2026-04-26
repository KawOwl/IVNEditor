import { beforeEach, describe, expect, it } from 'bun:test';
import { handleSessionMessage } from '#internal/stores/ws-message-handlers';
import { useGameStore } from '#internal/stores/game-store';
import type { SceneState, Sentence } from '@ivn/core/types';

const library: SceneState = {
  background: 'library',
  sprites: [{ id: 'luna', emotion: 'smile', position: 'center' }],
};

describe('ws-message-handlers restored readback', () => {
  beforeEach(() => {
    useGameStore.getState().reset();
  });

  it('replays server-projected sentences instead of reparsing raw entries', () => {
    const sentence: Sentence = {
      kind: 'dialogue',
      text: '你来了。',
      pf: { speaker: 'luna' },
      sceneRef: library,
      turnNumber: 1,
      index: 0,
    };

    handleSessionMessage(
      {
        type: 'restored',
        playthroughId: 'pt',
        status: 'waiting-input',
        inputType: 'choice',
        choices: ['调查', '离开'],
        hasMore: false,
        currentScene: library,
        sentences: [sentence],
        entries: [
          {
            role: 'generate',
            kind: 'narrative',
            content: '<scratch>不应该被前端当旁白解析。</scratch>',
          },
        ],
      },
      useGameStore.getState,
      'http://localhost',
    );

    const state = useGameStore.getState();
    expect(state.parsedSentences).toEqual([sentence]);
    expect(state.currentScene).toEqual(library);
    expect(state.inputType).toBe('choice');
    expect(state.choices).toEqual(['调查', '离开']);
    expect(state.status).toBe('waiting-input');
  });
});

// PR2 narrative-rewrite ws message handlers
describe('ws-message-handlers narrative-rewrite', () => {
  beforeEach(() => {
    useGameStore.getState().reset();
  });

  it('rewrite-attempted toggles isRewriting=true', () => {
    expect(useGameStore.getState().isRewriting).toBe(false);
    handleSessionMessage(
      { type: 'rewrite-attempted', rawTextLength: 100, looksBroken: true },
      useGameStore.getState,
      'http://localhost',
    );
    expect(useGameStore.getState().isRewriting).toBe(true);
  });

  it('rewrite-completed toggles isRewriting=false', () => {
    useGameStore.getState().setRewriting(true);
    handleSessionMessage(
      { type: 'rewrite-completed', status: 'ok', applied: true },
      useGameStore.getState,
      'http://localhost',
    );
    expect(useGameStore.getState().isRewriting).toBe(false);
  });

  it('narrative-turn-reset 清掉本 turn 的 sentence (按 max turnNumber)', () => {
    const scene: SceneState = { background: null, sprites: [] };
    const turn1: Sentence = { kind: 'narration', text: 'a', sceneRef: scene, turnNumber: 1, index: 0 };
    const turn2a: Sentence = { kind: 'narration', text: 'b', sceneRef: scene, turnNumber: 2, index: 1 };
    const turn2b: Sentence = { kind: 'narration', text: 'c', sceneRef: scene, turnNumber: 2, index: 2 };
    useGameStore.getState().appendSentence(turn1);
    useGameStore.getState().appendSentence(turn2a);
    useGameStore.getState().appendSentence(turn2b);
    expect(useGameStore.getState().parsedSentences).toHaveLength(3);

    handleSessionMessage(
      { type: 'narrative-turn-reset', reason: 'rewrite-applied' },
      useGameStore.getState,
      'http://localhost',
    );

    const state = useGameStore.getState();
    // turn 2 全部清掉，turn 1 保留
    expect(state.parsedSentences).toEqual([turn1]);
    // catch-up 重新打开，让 replay 后第一条新 sentence 自动推进
    expect(state.catchUpPending).toBe(true);
  });

  it('narrative-turn-reset 在 parsedSentences 为空时是 noop', () => {
    handleSessionMessage(
      { type: 'narrative-turn-reset', reason: 'rewrite-applied' },
      useGameStore.getState,
      'http://localhost',
    );
    // 不抛错、不改变 state
    expect(useGameStore.getState().parsedSentences).toEqual([]);
  });
});
