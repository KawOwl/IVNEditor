import { describe, expect, it } from 'bun:test';
import {
  batchId,
  createInputRequest,
  inputRequestId,
  stepId,
  turnId,
  type CoreEvent,
} from '#internal/game-session/core-events';
import { validateCoreEventSequence } from '#internal/game-session/core-event-protocol';

describe('CoreEvent protocol', () => {
  it('accepts a generate / signal / receive event sequence', () => {
    const tid = turnId(1);
    const sid = stepId(1, 0);
    const bid = batchId('batch-main')!;
    const rid = inputRequestId(1);
    const events: CoreEvent[] = [
      { type: 'session-started', snapshot: snapshot(0) },
      { type: 'generate-turn-started', turn: 1, turnId: tid },
      { type: 'assistant-message-started', turnId: tid },
      { type: 'llm-step-started', turnId: tid, stepId: sid, batchId: bid, isFollowup: false },
      { type: 'assistant-text-delta', turnId: tid, stepId: sid, batchId: bid, text: 'hi' },
      {
        type: 'narrative-segment-finalized',
        turnId: tid,
        stepId: sid,
        batchId: bid,
        reason: 'generate-complete',
        entry: { role: 'generate', content: 'hi' },
        sceneAfter: emptyScene,
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
      { type: 'assistant-message-finalized', turnId: tid, finishReason: 'stop' },
      { type: 'generate-turn-completed', turnId: tid, finishReason: 'stop', preview: 'hi', snapshot: snapshot(1) },
      {
        type: 'waiting-input-started',
        turnId: tid,
        requestId: rid,
        source: 'signal',
        causedByBatchId: bid,
        request: createInputRequest('next?', ['go']),
        snapshot: snapshot(1),
      },
      {
        type: 'player-input-recorded',
        turnId: tid,
        requestId: rid,
        batchId: batchId('receive-1')!,
        text: 'go',
        payload: { inputType: 'choice', selectedIndex: 0 },
        sentence: {
          kind: 'player_input',
          text: 'go',
          selectedIndex: 0,
          sceneRef: emptyScene,
          turnNumber: 1,
          index: 1,
        },
        snapshot: snapshot(1),
      },
    ];

    expect(validateCoreEventSequence(events).ok).toBe(true);
  });

  it('rejects text deltas before assistant-message-started', () => {
    const tid = turnId(1);
    const report = validateCoreEventSequence([
      { type: 'generate-turn-started', turn: 1, turnId: tid },
      { type: 'assistant-text-delta', turnId: tid, stepId: null, batchId: null, text: 'oops' },
    ]);

    expect(report.ok).toBe(false);
    expect(report.violations.map((violation) => violation.message)).toContain(
      'assistant-text-delta before assistant-message-started',
    );
  });

  it('rejects signal waiting input without a recorded signal request', () => {
    const tid = turnId(1);
    const bid = batchId('batch-main')!;
    const report = validateCoreEventSequence([
      { type: 'session-started', snapshot: snapshot(0) },
      { type: 'generate-turn-started', turn: 1, turnId: tid },
      { type: 'assistant-message-started', turnId: tid },
      { type: 'llm-step-started', turnId: tid, stepId: stepId(1, 0), batchId: bid, isFollowup: false },
      { type: 'assistant-message-finalized', turnId: tid, finishReason: 'stop' },
      { type: 'generate-turn-completed', turnId: tid, finishReason: 'stop', preview: null, snapshot: snapshot(1) },
      {
        type: 'waiting-input-started',
        turnId: tid,
        requestId: inputRequestId(1),
        source: 'signal',
        causedByBatchId: bid,
        request: createInputRequest('next?', ['go']),
        snapshot: snapshot(1),
      },
    ]);

    expect(report.ok).toBe(false);
    expect(report.violations.map((violation) => violation.message)).toContain(
      'waiting input causedByBatchId batch-main does not match pending signal null',
    );
  });

  it('rejects mismatched selected choice payloads', () => {
    const tid = turnId(1);
    const rid = inputRequestId(1);
    const report = validateCoreEventSequence([
      { type: 'session-started', snapshot: snapshot(0) },
      {
        type: 'waiting-input-started',
        turnId: tid,
        requestId: rid,
        source: 'restore',
        causedByBatchId: null,
        request: createInputRequest('next?', ['go', 'stay']),
        snapshot: snapshot(1),
      },
      {
        type: 'player-input-recorded',
        turnId: tid,
        requestId: rid,
        batchId: batchId('receive-1')!,
        text: 'stay',
        payload: { inputType: 'choice', selectedIndex: 0 },
        sentence: {
          kind: 'player_input',
          text: 'stay',
          selectedIndex: 0,
          sceneRef: emptyScene,
          turnNumber: 1,
          index: 1,
        },
        snapshot: snapshot(1),
      },
    ]);

    expect(report.ok).toBe(false);
    expect(report.violations.map((violation) => violation.message)).toContain(
      'choice text "stay" does not match selectedIndex 0',
    );
  });

  it('rejects tool finishes without matching starts', () => {
    const tid = turnId(1);
    const bid = batchId('batch-main')!;
    const report = validateCoreEventSequence([
      { type: 'session-started', snapshot: snapshot(0) },
      { type: 'generate-turn-started', turn: 1, turnId: tid },
      { type: 'assistant-message-started', turnId: tid },
      { type: 'llm-step-started', turnId: tid, stepId: stepId(1, 0), batchId: bid, isFollowup: false },
      {
        type: 'tool-call-finished',
        turnId: tid,
        stepId: stepId(1, 0),
        batchId: bid,
        toolName: 'update_state',
        input: { key: 'chapter' },
        output: { ok: true },
      },
    ]);

    expect(report.ok).toBe(false);
    expect(report.violations.map((violation) => violation.message)).toContain(
      'tool-call-finished without matching tool-call-started for update_state',
    );
  });

  it('rejects runtime events after a terminal session state', () => {
    const tid = turnId(1);
    const report = validateCoreEventSequence([
      { type: 'session-started', snapshot: snapshot(0) },
      { type: 'session-finished', snapshot: snapshot(0) },
      { type: 'generate-turn-started', turn: 1, turnId: tid },
    ]);

    expect(report.ok).toBe(false);
    expect(report.violations.map((violation) => violation.message)).toContain(
      'generate-turn-started after terminal phase finished',
    );
  });
});

const emptyScene = { background: null, sprites: [] };

function snapshot(turn: number) {
  return {
    turn,
    stateVars: {},
    memorySnapshot: {},
    currentScene: emptyScene,
  };
}
