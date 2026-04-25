import { describe, expect, it } from 'bun:test';
import {
  batchId,
  createInputRequest,
  inputRequestId,
  stepId,
  turnId,
  type CoreEvent,
} from '#internal/game-session/core-events';
import { createSessionPersistenceCoreEventSink } from '#internal/game-session/persistence-core-event-sink';
import type { SessionPersistence } from '#internal/game-session/types';

describe('SessionPersistence CoreEvent sink', () => {
  it('interprets durable CoreEvents into persistence callbacks in order', async () => {
    const calls: Array<{ name: string; data: unknown }> = [];
    const persistence = createPersistenceRecorder(calls);
    const sink = createSessionPersistenceCoreEventSink(persistence);
    const tid = turnId(1);
    const sid = stepId(1, 0);
    const bid = batchId('batch-main')!;
    const requestId = inputRequestId(1);

    const events: CoreEvent[] = [
      { type: 'generate-turn-started', turn: 1, turnId: tid },
      {
        type: 'narrative-segment-finalized',
        turnId: tid,
        stepId: sid,
        batchId: bid,
        reason: 'generate-complete',
        entry: { role: 'generate', content: 'hello', reasoning: 'thought', finishReason: 'stop' },
        sceneAfter: emptyScene,
      },
      {
        type: 'tool-call-finished',
        turnId: tid,
        stepId: sid,
        batchId: bid,
        toolName: 'update_state',
        input: { key: 'mood' },
        output: { ok: true },
      },
      {
        type: 'generate-turn-completed',
        turnId: tid,
        finishReason: 'stop',
        preview: 'hello',
        snapshot: snapshot(1, { hp: 3 }, { entries: 1 }),
      },
      {
        type: 'signal-input-recorded',
        turnId: tid,
        batchId: bid,
        request: createInputRequest('next?', ['go']),
        sentence: {
          kind: 'signal_input',
          hint: 'next?',
          choices: ['go'],
          sceneRef: emptyScene,
          turnNumber: 1,
          index: 1,
        },
        sceneAfter: emptyScene,
      },
      {
        type: 'waiting-input-started',
        turnId: tid,
        requestId,
        source: 'signal',
        causedByBatchId: bid,
        request: createInputRequest('next?', ['go']),
        snapshot: snapshot(1, { hp: 4 }, { entries: 2 }),
      },
      {
        type: 'player-input-recorded',
        turnId: tid,
        requestId,
        batchId: batchId('receive-1')!,
        text: 'go',
        payload: { inputType: 'choice', selectedIndex: 0 },
        sentence: {
          kind: 'player_input',
          text: 'go',
          selectedIndex: 0,
          sceneRef: emptyScene,
          turnNumber: 1,
          index: 2,
        },
        snapshot: snapshot(1, { hp: 5 }, { entries: 3 }),
      },
      { type: 'session-finished', reason: 'done', snapshot: snapshot(1, { hp: 5 }, { entries: 3 }) },
    ];

    for (const event of events) {
      sink.publish(event);
    }

    await sink.flushDurable();

    expect(calls).toEqual([
      { name: 'onGenerateStart', data: 1 },
      {
        name: 'onNarrativeSegmentFinalized',
        data: {
          entry: { role: 'generate', content: 'hello', reasoning: 'thought', finishReason: 'stop' },
          batchId: 'batch-main',
        },
      },
      {
        name: 'onToolCallRecorded',
        data: {
          toolName: 'update_state',
          input: { key: 'mood' },
          output: { ok: true },
          batchId: 'batch-main',
        },
      },
      {
        name: 'onGenerateComplete',
        data: {
          memorySnapshot: { entries: 1 },
          preview: 'hello',
          currentScene: emptyScene,
        },
      },
      {
        name: 'onSignalInputRecorded',
        data: { hint: 'next?', choices: ['go'], batchId: 'batch-main' },
      },
      {
        name: 'onWaitingInput',
        data: {
          hint: 'next?',
          inputType: 'choice',
          choices: ['go'],
          memorySnapshot: { entries: 2 },
          currentScene: emptyScene,
          stateVars: { hp: 4 },
        },
      },
      {
        name: 'onReceiveComplete',
        data: {
          entry: { role: 'receive', content: 'go' },
          stateVars: { hp: 5 },
          turn: 1,
          memorySnapshot: { entries: 3 },
          payload: { inputType: 'choice', selectedIndex: 0 },
          batchId: 'receive-1',
        },
      },
      { name: 'onScenarioFinished', data: { reason: 'done' } },
    ]);
  });

  it('does not rewrite waiting-input persistence for restore projection events', async () => {
    const calls: Array<{ name: string; data: unknown }> = [];
    const sink = createSessionPersistenceCoreEventSink(createPersistenceRecorder(calls));

    sink.publish({
      type: 'waiting-input-started',
      turnId: turnId(3),
      requestId: inputRequestId(3),
      source: 'restore',
      causedByBatchId: null,
      request: createInputRequest('restored?', ['yes']),
      snapshot: snapshot(3, { restored: true }, { entries: 9 }),
    });
    await sink.flushDurable();

    expect(calls).toEqual([]);
  });
});

const emptyScene = { background: null, sprites: [] };

function snapshot(
  turn: number,
  stateVars: Record<string, unknown>,
  memorySnapshot: Record<string, unknown>,
) {
  return {
    turn,
    stateVars,
    memorySnapshot,
    currentScene: emptyScene,
  };
}

function createPersistenceRecorder(
  calls: Array<{ name: string; data: unknown }>,
): SessionPersistence {
  return {
    async onGenerateStart(turn) {
      calls.push({ name: 'onGenerateStart', data: turn });
    },
    async onNarrativeSegmentFinalized(data) {
      calls.push({ name: 'onNarrativeSegmentFinalized', data });
    },
    async onGenerateComplete(data) {
      calls.push({ name: 'onGenerateComplete', data });
    },
    async onWaitingInput(data) {
      calls.push({ name: 'onWaitingInput', data });
    },
    async onSignalInputRecorded(data) {
      calls.push({ name: 'onSignalInputRecorded', data });
    },
    async onToolCallRecorded(data) {
      calls.push({ name: 'onToolCallRecorded', data });
    },
    async onReceiveComplete(data) {
      calls.push({ name: 'onReceiveComplete', data });
    },
    async onScenarioFinished(data) {
      calls.push({ name: 'onScenarioFinished', data });
    },
  };
}
