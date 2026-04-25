import { describe, expect, it } from 'bun:test';
import { readCurrentPlaythrough } from '#internal/current-readback';
import { buildParserManifest } from '#internal/narrative-parser-v2';
import type { NarrativeEntry } from '#internal/persistence-entry';

const parserManifest = buildParserManifest({
  characters: [{ id: 'luna', sprites: [{ id: 'smile' }, { id: 'neutral' }] }],
  backgrounds: [{ id: 'library' }, { id: 'hall' }],
});

describe('readCurrentPlaythrough', () => {
  it('reconstructs current declarative visual entries as readonly sentences', () => {
    const result = readCurrentPlaythrough({
      parserManifest,
      initialScene: { background: 'hall', sprites: [] },
      entries: [
        entry({
          orderIdx: 2,
          kind: 'signal_input',
          role: 'system',
          content: '要做什么？',
          payload: { choices: ['调查', '离开'] },
        }),
        entry({
          orderIdx: 0,
          kind: 'narrative',
          role: 'generate',
          content:
            '<dialogue speaker="luna"><background scene="library"/><sprite char="luna" mood="smile" position="center"/>你来了。</dialogue>',
        }),
        entry({
          orderIdx: 1,
          kind: 'narrative',
          role: 'generate',
          content: '<scratch>不要显示这段系统记录。</scratch><narration>书架之间有一道暗门。</narration>',
        }),
        entry({
          orderIdx: 3,
          kind: 'player_input',
          role: 'receive',
          content: '调查',
          payload: { inputType: 'choice', selectedIndex: 0 },
        }),
      ],
    });

    expect(result.protocolVersion).toBe('v2-declarative-visual');
    expect(result.warnings).toEqual([]);
    expect(result.sentences.map((sentence) => sentence.kind)).toEqual([
      'dialogue',
      'narration',
      'signal_input',
      'player_input',
    ]);
    expect(result.sentences[0]).toMatchObject({
      kind: 'dialogue',
      text: '你来了。',
      pf: { speaker: 'luna' },
      sceneRef: {
        background: 'library',
        sprites: [{ id: 'luna', emotion: 'smile', position: 'center' }],
      },
      turnNumber: 1,
      index: 0,
    });
    expect(result.sentences[1]).toMatchObject({
      kind: 'narration',
      text: '书架之间有一道暗门。',
      sceneRef: {
        background: 'library',
        sprites: [{ id: 'luna', emotion: 'smile', position: 'center' }],
      },
      turnNumber: 1,
      index: 2,
    });
    expect(result.sentences[2]).toMatchObject({
      kind: 'signal_input',
      hint: '要做什么？',
      choices: ['调查', '离开'],
      turnNumber: 1,
      index: 3,
    });
    expect(result.sentences[3]).toMatchObject({
      kind: 'player_input',
      text: '调查',
      selectedIndex: 0,
      turnNumber: 1,
      index: 4,
    });
    expect(result.finalScene).toEqual({
      background: 'library',
      sprites: [{ id: 'luna', emotion: 'smile', position: 'center' }],
    });
    expect(result.nextTurn).toBe(2);
    expect(result.nextIndex).toBe(5);
  });

  it('can continue from a previously projected page', () => {
    const firstPage = readCurrentPlaythrough({
      parserManifest,
      entries: [
        entry({
          orderIdx: 0,
          kind: 'narrative',
          role: 'generate',
          content:
            '<narration><background scene="library"/><sprite char="luna" mood="neutral" position="center"/>第一页。</narration>',
        }),
      ],
    });

    const secondPage = readCurrentPlaythrough({
      parserManifest,
      initialScene: firstPage.finalScene,
      initialTurn: firstPage.nextTurn,
      startIndex: firstPage.nextIndex,
      entries: [
        entry({
          orderIdx: 1,
          kind: 'narrative',
          role: 'generate',
          content: '<dialogue speaker="luna">第二页。</dialogue>',
        }),
      ],
    });

    expect(secondPage.sentences[0]).toMatchObject({
      kind: 'dialogue',
      text: '第二页。',
      sceneRef: {
        background: 'library',
        sprites: [{ id: 'luna', emotion: 'neutral', position: 'center' }],
      },
      index: 1,
    });
  });
});

function entry(
  partial: Partial<NarrativeEntry> & Pick<NarrativeEntry, 'kind' | 'orderIdx' | 'role' | 'content'>,
): NarrativeEntry {
  return {
    id: `entry-${partial.orderIdx}`,
    playthroughId: 'pt-current',
    reasoning: null,
    finishReason: null,
    batchId: null,
    createdAt: new Date(partial.orderIdx),
    payload: null,
    ...partial,
  };
}
