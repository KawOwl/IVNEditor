import { describe, expect, it } from 'bun:test';
import {
  createInputRequest,
  inputRequestId,
  turnId,
  type CoreEvent,
} from '@ivn/core/game-session';
import { createWebSocketCoreEventSink } from '#internal/ws-core-event-sink';

describe('createWebSocketCoreEventSink', () => {
  it('projects CoreEvents into existing WebSocket messages', () => {
    const sent: string[] = [];
    const sink = createWebSocketCoreEventSink(
      { send: (data) => sent.push(data) },
      { enableDebug: true },
    );

    for (const event of events) {
      sink.publish(event);
    }

    expect(sent.map((message) => JSON.parse(message) as { type: string })).toMatchObject([
      { type: 'reset' },
      { type: 'status', status: 'loading' },
      { type: 'scene-change', scene: emptyScene },
      { type: 'update-debug', totalTurns: 0 },
      { type: 'status', status: 'generating' },
      { type: 'input-hint', hint: '下一步？' },
      { type: 'input-type', inputType: 'choice', choices: ['继续'] },
      { type: 'status', status: 'waiting-input' },
    ]);
  });
});

const emptyScene = { background: null, sprites: [] };

const events: CoreEvent[] = [
  {
    type: 'session-started',
    snapshot: {
      turn: 0,
      stateVars: {},
      memorySnapshot: {},
      currentScene: emptyScene,
    },
  },
  {
    type: 'generate-turn-started',
    turn: 1,
    turnId: turnId(1),
  },
  {
    type: 'waiting-input-started',
    turnId: turnId(1),
    requestId: inputRequestId(1),
    source: 'signal',
    causedByBatchId: null,
    request: createInputRequest('下一步？', ['继续']),
    snapshot: {
      turn: 1,
      stateVars: {},
      memorySnapshot: {},
      currentScene: emptyScene,
    },
  },
];
