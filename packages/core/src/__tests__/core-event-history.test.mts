import { describe, expect, it } from 'bun:test';
import {
  batchId,
  createInputRequest,
  inputRequestId,
  turnId,
} from '#internal/game-session/core-events';
import {
  buildMessagesFromCoreEventHistory,
  projectCoreEventHistoryPage,
  projectCoreEventHistoryToMemoryEntries,
  type CoreEventHistoryItem,
} from '#internal/game-session/core-event-history';
import type { CoreEvent } from '#internal/game-session/core-events';

const emptyScene = { background: null, sprites: [] };

describe('CoreEvent history projection', () => {
  it('projects paginated readback sentences from ordered CoreEvents', () => {
    const page = projectCoreEventHistoryPage([
      item(3, {
        type: 'player-input-recorded',
        turnId: turnId(1),
        requestId: inputRequestId(1),
        batchId: batchId('receive-1')!,
        text: '前进',
        payload: { inputType: 'choice', selectedIndex: 0 },
        sentence: {
          kind: 'player_input',
          text: '前进',
          selectedIndex: 0,
          sceneRef: emptyScene,
          turnNumber: 1,
          index: 2,
        },
        snapshot: {
          turn: 1,
          stateVars: {},
          memorySnapshot: {},
          currentScene: emptyScene,
        },
      }),
      item(1, {
        type: 'narrative-batch-emitted',
        turnId: turnId(1),
        batchId: batchId('batch-1'),
        sentences: [{
          kind: 'narration',
          text: '雨停了。',
          sceneRef: emptyScene,
          bgChanged: false,
          spritesChanged: false,
          turnNumber: 1,
          index: 0,
        }],
        scratches: [],
        degrades: [],
        sceneAfter: emptyScene,
      }),
      item(2, {
        type: 'signal-input-recorded',
        turnId: turnId(1),
        batchId: batchId('batch-1'),
        request: createInputRequest('接下来？', ['前进']),
        sentence: {
          kind: 'signal_input',
          hint: '接下来？',
          choices: ['前进'],
          sceneRef: emptyScene,
          turnNumber: 1,
          index: 1,
        },
        sceneAfter: emptyScene,
      }),
    ], { offset: 1, limit: 2 });

    expect(page).toEqual({
      sentences: [
        {
          kind: 'signal_input',
          hint: '接下来？',
          choices: ['前进'],
          sceneRef: emptyScene,
          turnNumber: 1,
          index: 1,
        },
        {
          kind: 'player_input',
          text: '前进',
          selectedIndex: 0,
          sceneRef: emptyScene,
          turnNumber: 1,
          index: 2,
        },
      ],
      offset: 1,
      limit: 2,
      totalEntries: 3,
      hasMore: false,
      nextOffset: 3,
    });
  });

  it('builds recent model messages from CoreEvent content events', () => {
    const messages = buildMessagesFromCoreEventHistory([
      item(1, {
        type: 'narrative-segment-finalized',
        turnId: turnId(1),
        stepId: null,
        batchId: batchId('batch-1'),
        reason: 'generate-complete',
        entry: { role: 'generate', content: '旁白', reasoning: '思考', finishReason: 'stop' },
        sceneAfter: emptyScene,
      }),
      item(2, {
        type: 'tool-call-finished',
        turnId: turnId(1),
        stepId: null,
        batchId: batchId('batch-1'),
        toolName: 'update_state',
        input: { hp: 1 },
        output: { ok: true },
      }),
      item(3, {
        type: 'player-input-recorded',
        turnId: turnId(1),
        requestId: null,
        batchId: batchId('receive-1')!,
        text: '继续',
        payload: { inputType: 'freetext' },
        sentence: {
          kind: 'player_input',
          text: '继续',
          sceneRef: emptyScene,
          turnNumber: 1,
          index: 3,
        },
        snapshot: {
          turn: 1,
          stateVars: {},
          memorySnapshot: {},
          currentScene: emptyScene,
        },
      }),
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[0]!.role).toBe('assistant');
    expect(messages[1]!.role).toBe('tool');
    expect(messages[2]).toEqual({ role: 'user', content: '继续' });
    expect(JSON.stringify(messages[0]!.content)).toContain('update_state');
  });

  it('projects compactable memory entries with CoreEvent sequence cursors', () => {
    const entries = projectCoreEventHistoryToMemoryEntries([
      item(10, {
        type: 'narrative-segment-finalized',
        turnId: turnId(2),
        stepId: null,
        batchId: batchId('batch-2'),
        reason: 'generate-complete',
        entry: { role: 'generate', content: '第二轮旁白' },
        sceneAfter: emptyScene,
      }),
      item(11, {
        type: 'player-input-recorded',
        turnId: turnId(2),
        requestId: null,
        batchId: batchId('receive-2')!,
        text: '玩家回答',
        payload: { inputType: 'freetext' },
        sentence: {
          kind: 'player_input',
          text: '玩家回答',
          sceneRef: emptyScene,
          turnNumber: 2,
          index: 11,
        },
        snapshot: {
          turn: 2,
          stateVars: {},
          memorySnapshot: {},
          currentScene: emptyScene,
        },
      }),
    ]);

    expect(entries.map(({ role, content, sequence, turn }) => ({
      role,
      content,
      sequence,
      turn,
    }))).toEqual([
      { role: 'generate', content: '第二轮旁白', sequence: 10, turn: 2 },
      { role: 'receive', content: '玩家回答', sequence: 11, turn: 2 },
    ]);
  });
});

function item(sequence: number, event: CoreEvent): CoreEventHistoryItem {
  return {
    sequence,
    occurredAt: sequence,
    event,
  };
}
