import { describe, expect, it } from 'bun:test';
import {
  batchId,
  createInputRequest,
  deriveCoreEventLogRestoreState,
  deriveCoreEventRestoreState,
  inputRequestId,
  turnId,
  type CoreEvent,
  type CoreEventEnvelope,
  type SessionSnapshot,
} from '#internal/game-session';

const emptyScene = { background: null, sprites: [] };

describe('CoreEvent log restore reducer', () => {
  it('restores a waiting input request from the event log', () => {
    const state = deriveCoreEventRestoreState([
      { type: 'session-started', snapshot: snapshot(0) },
      {
        type: 'waiting-input-started',
        turnId: turnId(1),
        requestId: inputRequestId(1),
        source: 'signal',
        causedByBatchId: batchId('batch-1'),
        request: createInputRequest('pick?', ['A', 'B']),
        snapshot: snapshot(1, { trust: 1 }),
      },
    ]);

    expect(state).toEqual({
      status: 'waiting-input',
      turn: 1,
      stateVars: { trust: 1 },
      memorySnapshot: { entries: [], summaries: [] },
      currentScene: emptyScene,
      inputHint: 'pick?',
      inputType: 'choice',
      choices: ['A', 'B'],
    });
  });

  it('continues from idle after the waiting request has already been consumed', () => {
    const state = deriveCoreEventRestoreState([
      {
        type: 'waiting-input-started',
        turnId: turnId(1),
        requestId: inputRequestId(1),
        source: 'signal',
        causedByBatchId: batchId('batch-1'),
        request: createInputRequest('pick?', ['A', 'B']),
        snapshot: snapshot(1),
      },
      {
        type: 'player-input-recorded',
        turnId: turnId(1),
        requestId: inputRequestId(1),
        batchId: batchId('receive-1')!,
        text: 'B',
        payload: { inputType: 'choice', selectedIndex: 1 },
        sentence: {
          kind: 'player_input',
          text: 'B',
          selectedIndex: 1,
          sceneRef: emptyScene,
          turnNumber: 1,
          index: 2,
        },
        snapshot: snapshot(1, { picked: 'B' }),
      },
    ]);

    expect(state).toMatchObject({
      status: 'idle',
      turn: 1,
      stateVars: { picked: 'B' },
      inputHint: null,
      inputType: 'freetext',
      choices: null,
    });
  });

  it('promotes a completed generate without waiting event into a waiting restore point', () => {
    const events: CoreEvent[] = [
      { type: 'generate-turn-started', turn: 2, turnId: turnId(2) },
      {
        type: 'signal-input-recorded',
        turnId: turnId(2),
        batchId: batchId('batch-2'),
        request: createInputRequest('next?', ['Go']),
        sentence: {
          kind: 'signal_input',
          hint: 'next?',
          choices: ['Go'],
          sceneRef: emptyScene,
          turnNumber: 2,
          index: 5,
        },
        sceneAfter: emptyScene,
      },
      {
        type: 'generate-turn-completed',
        turnId: turnId(2),
        finishReason: 'tool-calls',
        preview: 'preview',
        snapshot: snapshot(2, { done: true }),
      },
      {
        type: 'memory-compaction-completed',
        turnId: turnId(2),
        snapshot: snapshot(2, { done: true, compacted: true }),
      },
    ];

    expect(deriveCoreEventRestoreState(events)).toMatchObject({
      status: 'waiting-input',
      turn: 2,
      stateVars: { done: true, compacted: true },
      inputHint: 'next?',
      inputType: 'choice',
      choices: ['Go'],
    });
  });

  it('rolls back an interrupted generate to the last stable checkpoint', () => {
    const state = deriveCoreEventRestoreState([
      { type: 'session-started', snapshot: snapshot(0) },
      { type: 'generate-turn-started', turn: 1, turnId: turnId(1) },
      { type: 'assistant-message-started', turnId: turnId(1) },
      {
        type: 'assistant-text-delta',
        turnId: turnId(1),
        stepId: null,
        batchId: null,
        text: 'partial',
      },
    ]);

    expect(state).toMatchObject({
      status: 'idle',
      turn: 0,
      inputType: 'freetext',
      choices: null,
    });
  });

  it('derives restore state from sorted envelopes', () => {
    const state = deriveCoreEventLogRestoreState([
      envelope(2, {
        type: 'waiting-input-started',
        turnId: turnId(1),
        requestId: inputRequestId(1),
        source: 'fallback',
        causedByBatchId: null,
        request: createInputRequest(null, null),
        snapshot: snapshot(1),
      }),
      envelope(1, { type: 'session-started', snapshot: snapshot(0) }),
    ], { sortBySequence: true });

    expect(state?.status).toBe('waiting-input');
    expect(state?.turn).toBe(1);
    expect(state?.inputType).toBe('freetext');
  });
});

function snapshot(turn: number, stateVars: Record<string, unknown> = {}): SessionSnapshot {
  return {
    turn,
    stateVars,
    memorySnapshot: { entries: [], summaries: [] },
    currentScene: emptyScene,
  };
}

function envelope(sequence: number, event: CoreEvent): CoreEventEnvelope {
  return {
    schemaVersion: 1,
    sequence,
    occurredAt: sequence,
    playthroughId: 'pt-restore',
    event,
  };
}
