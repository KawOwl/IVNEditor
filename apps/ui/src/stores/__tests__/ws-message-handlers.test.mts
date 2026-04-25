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
