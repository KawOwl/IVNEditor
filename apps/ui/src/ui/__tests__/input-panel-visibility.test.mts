import { describe, expect, it } from 'bun:test';
import { isAtReadableEnd } from '#internal/ui/input-panel-visibility';
import type { SceneState, Sentence } from '@ivn/core/types';

const scene: SceneState = { background: null, sprites: [] };

function narration(index: number): Sentence {
  return { kind: 'narration', text: `s${index}`, sceneRef: scene, turnNumber: 1, index };
}

function signalInput(index: number): Sentence {
  return {
    kind: 'signal_input',
    hint: 'next?',
    choices: ['A', 'B'],
    sceneRef: scene,
    turnNumber: 1,
    index,
  };
}

function sceneChange(index: number): Sentence {
  return { kind: 'scene_change', scene, turnNumber: 1, index };
}

describe('input panel visibility', () => {
  it('treats an empty restored readback as already readable to the end', () => {
    expect(isAtReadableEnd([], null)).toBe(true);
  });

  it('treats skippable-only history as already readable to the end', () => {
    expect(isAtReadableEnd([sceneChange(0), signalInput(1)], null)).toBe(true);
  });

  it('requires a visible cursor when displayable sentences exist', () => {
    expect(isAtReadableEnd([narration(0)], null)).toBe(false);
    expect(isAtReadableEnd([narration(0)], 0)).toBe(true);
  });

  it('does not expose choices before the last displayable sentence', () => {
    expect(isAtReadableEnd([narration(0), signalInput(1), narration(2)], 0)).toBe(false);
    expect(isAtReadableEnd([narration(0), signalInput(1), narration(2)], 2)).toBe(true);
  });
});
