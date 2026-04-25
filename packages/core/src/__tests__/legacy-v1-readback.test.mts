import { describe, expect, it } from 'bun:test';
import { readLegacyV1Playthrough } from '#internal/legacy-v1-readback';
import type { NarrativeEntry } from '#internal/persistence-entry';

describe('readLegacyV1Playthrough', () => {
  it('reconstructs readonly sentences from v1 narrative and visual tool entries', () => {
    const result = readLegacyV1Playthrough({
      initialScene: { background: 'hall', sprites: [] },
      entries: [
        entry({
          orderIdx: 3,
          kind: 'signal_input',
          role: 'generate',
          content: '要做什么？',
          payload: { choices: ['调查', '离开'] },
        }),
        entry({
          orderIdx: 1,
          kind: 'tool_call',
          role: 'generate',
          content: 'change_scene',
          payload: {
            input: {
              background: 'library',
              sprites: [{ id: 'luna', emotion: 'smile', position: 'center' }],
              transition: 'fade',
            },
            output: { success: true },
          },
        }),
        entry({
          orderIdx: 0,
          kind: 'narrative',
          role: 'generate',
          content: '<d s="luna" to="player">你来了。</d>\n\n大厅里很安静。',
        }),
        entry({
          orderIdx: 2,
          kind: 'narrative',
          role: 'generate',
          content: '书架之间有一道暗门。',
        }),
        entry({
          orderIdx: 4,
          kind: 'player_input',
          role: 'receive',
          content: '调查',
          payload: { inputType: 'choice', selectedIndex: 0 },
        }),
        entry({
          orderIdx: 5,
          kind: 'tool_call',
          role: 'generate',
          content: 'change_sprite',
          payload: {
            input: { character: 'luna', emotion: 'neutral', position: 'right' },
            output: { success: true },
          },
        }),
      ],
    });

    expect(result.protocolVersion).toBe('v1-tool-call');
    expect(result.warnings).toEqual([]);
    expect(result.sentences.map((sentence) => sentence.kind)).toEqual([
      'dialogue',
      'narration',
      'scene_change',
      'narration',
      'signal_input',
      'player_input',
      'scene_change',
    ]);
    expect(result.sentences[0]).toMatchObject({
      kind: 'dialogue',
      text: '你来了。',
      pf: { speaker: 'luna', addressee: ['player'] },
      sceneRef: { background: 'hall', sprites: [] },
      turnNumber: 1,
      index: 0,
    });
    expect(result.sentences[2]).toEqual({
      kind: 'scene_change',
      scene: {
        background: 'library',
        sprites: [{ id: 'luna', emotion: 'smile', position: 'center' }],
      },
      transition: 'fade',
      turnNumber: 1,
      index: 2,
    });
    expect(result.sentences[3]).toMatchObject({
      kind: 'narration',
      text: '书架之间有一道暗门。',
      sceneRef: {
        background: 'library',
        sprites: [{ id: 'luna', emotion: 'smile', position: 'center' }],
      },
    });
    expect(result.sentences[5]).toMatchObject({
      kind: 'player_input',
      text: '调查',
      selectedIndex: 0,
      turnNumber: 1,
    });
    expect(result.sentences[6]).toEqual({
      kind: 'scene_change',
      scene: {
        background: 'library',
        sprites: [{ id: 'luna', emotion: 'neutral', position: 'right' }],
      },
      turnNumber: 2,
      index: 6,
    });
    expect(result.finalScene).toEqual({
      background: 'library',
      sprites: [{ id: 'luna', emotion: 'neutral', position: 'right' }],
    });
  });

  it('keeps invalid visual tool calls as warnings instead of failing readback', () => {
    const result = readLegacyV1Playthrough({
      entries: [
        entry({
          orderIdx: 0,
          kind: 'tool_call',
          role: 'generate',
          content: 'change_scene',
          payload: { input: { sprites: 'bad' }, output: { success: true } },
        }),
        entry({
          orderIdx: 1,
          kind: 'tool_call',
          role: 'generate',
          content: 'change_sprite',
          payload: { input: { character: 'luna' }, output: { success: true } },
        }),
        entry({
          orderIdx: 2,
          kind: 'tool_call',
          role: 'generate',
          content: 'clear_stage',
          payload: { input: {}, output: { success: false } },
        }),
      ],
    });

    expect(result.sentences).toEqual([]);
    expect(result.finalScene).toEqual({ background: null, sprites: [] });
    expect(result.warnings.map((warning) => warning.code)).toEqual([
      'invalid-scene-tool-payload',
      'invalid-scene-tool-payload',
      'failed-scene-tool',
    ]);
  });
});

function entry(
  partial: Partial<NarrativeEntry> & Pick<NarrativeEntry, 'kind' | 'orderIdx' | 'role' | 'content'>,
): NarrativeEntry {
  return {
    id: `entry-${partial.orderIdx}`,
    playthroughId: 'pt-v1',
    reasoning: null,
    finishReason: null,
    batchId: null,
    createdAt: new Date(partial.orderIdx),
    payload: null,
    ...partial,
  };
}
