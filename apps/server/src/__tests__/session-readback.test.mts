import { describe, expect, it } from 'bun:test';
import { projectReadbackPage } from '#internal/session-readback';
import type { NarrativeEntryRow } from '#internal/services/playthrough-service';
import type { ScriptManifest } from '@ivn/core/types';

describe('projectReadbackPage', () => {
  it('projects current declarative entries to sentences for restore payloads', () => {
    const page = projectReadbackPage({
      manifest: manifest(),
      pageEntries: [
        entry({
          orderIdx: 0,
          kind: 'narrative',
          role: 'generate',
          content:
            '<dialogue speaker="luna"><background scene="library"/><sprite char="luna" mood="smile" position="center"/>你来了。</dialogue><scratch>隐藏记录</scratch>',
        }),
      ],
      offset: 0,
      limit: 1,
      totalEntries: 1,
    });

    expect(page.nextOffset).toBe(1);
    expect(page.hasMore).toBe(false);
    expect(page.sentences).toHaveLength(1);
    expect(page.sentences[0]).toMatchObject({
      kind: 'dialogue',
      text: '你来了。',
      pf: { speaker: 'luna' },
      sceneRef: {
        background: 'library',
        sprites: [{ id: 'luna', emotion: 'smile', position: 'center' }],
      },
    });
  });

  it('uses prefix entries to continue scene and sentence indexes for paginated readback', () => {
    const page = projectReadbackPage({
      manifest: manifest(),
      prefixEntries: [
        entry({
          orderIdx: 0,
          kind: 'narrative',
          role: 'generate',
          content:
            '<narration><background scene="library"/><sprite char="luna" mood="neutral" position="center"/>第一页。</narration>',
        }),
      ],
      pageEntries: [
        entry({
          orderIdx: 1,
          kind: 'narrative',
          role: 'generate',
          content: '<dialogue speaker="luna">第二页。</dialogue>',
        }),
      ],
      offset: 1,
      limit: 1,
      totalEntries: 2,
    });

    expect(page.nextOffset).toBe(2);
    expect(page.sentences[0]).toMatchObject({
      kind: 'dialogue',
      text: '第二页。',
      index: 1,
      sceneRef: {
        background: 'library',
        sprites: [{ id: 'luna', emotion: 'neutral', position: 'center' }],
      },
    });
  });

  it('keeps protocol-less historical v1 entries readable', () => {
    const page = projectReadbackPage({
      manifest: manifest(),
      pageEntries: [
        entry({
          orderIdx: 0,
          kind: 'narrative',
          role: 'generate',
          content: '<d s="luna">旧对话。</d>',
        }),
      ],
      offset: 0,
      limit: 1,
      totalEntries: 1,
    });

    expect(page.sentences[0]).toMatchObject({
      kind: 'dialogue',
      text: '旧对话。',
      pf: { speaker: 'luna' },
    });
  });
});

function manifest(): ScriptManifest {
  return {
    id: 'script',
    label: 'Script',
    chapters: [],
    stateSchema: { variables: [] },
    memoryConfig: {
      contextBudget: 12000,
      compressionThreshold: 100000,
      recencyWindow: 20,
    },
    enabledTools: [],
    characters: [{ id: 'luna', displayName: 'Luna', sprites: [{ id: 'smile' }, { id: 'neutral' }] }],
    backgrounds: [{ id: 'library', label: 'Library' }],
  };
}

function entry(
  partial: Partial<NarrativeEntryRow> & Pick<NarrativeEntryRow, 'kind' | 'orderIdx' | 'role' | 'content'>,
): NarrativeEntryRow {
  return {
    id: `entry-${partial.orderIdx}`,
    playthroughId: 'pt',
    reasoning: null,
    finishReason: null,
    batchId: null,
    payload: null,
    createdAt: new Date(partial.orderIdx),
    ...partial,
  };
}
