import { describe, expect, it } from 'bun:test';
import {
  batchId,
  createCoreEventBus,
  createRecordingCoreEventSink,
  replayCoreEventEnvelopes,
  stepId,
  turnId,
  type CoreEventEnvelope,
  type CoreEventLogWriter,
} from '#internal/game-session';
import { createCoreEventLogSink } from '#internal/game-session/event-log-core-event-sink';

describe('CoreEvent log sink', () => {
  it('writes cloned envelopes with stable sequence numbers', async () => {
    const envelopes: CoreEventEnvelope[] = [];
    const writer = createMemoryWriter(envelopes);
    const sink = createCoreEventLogSink({
      playthroughId: 'pt-log',
      writer,
      now: createClock(1000),
    });
    const event = {
      type: 'generate-turn-started',
      turn: 1,
      turnId: turnId(1),
    } as const;

    sink.publish(event);
    sink.publish({ type: 'assistant-message-started', turnId: turnId(1) });
    await sink.flushDurable();

    expect(envelopes).toEqual([
      {
        schemaVersion: 1,
        sequence: 1,
        occurredAt: 1000,
        playthroughId: 'pt-log',
        event,
      },
      {
        schemaVersion: 1,
        sequence: 2,
        occurredAt: 1001,
        playthroughId: 'pt-log',
        event: { type: 'assistant-message-started', turnId: turnId(1) },
      },
    ]);
  });

  it('continues sequence numbers from an existing log tail', async () => {
    const envelopes: CoreEventEnvelope[] = [];
    const sink = createCoreEventLogSink({
      playthroughId: 'pt-log',
      writer: createMemoryWriter(envelopes),
      now: createClock(2000),
      initialSequence: 41,
    });

    sink.publish({ type: 'generate-turn-started', turn: 1, turnId: turnId(1) });
    await sink.flushDurable();

    expect(envelopes[0]?.sequence).toBe(42);
  });

  it('replays envelopes into a sink in sequence order when requested', async () => {
    const recorder = createRecordingCoreEventSink({ playthroughId: 'pt-replay' });
    const bus = createCoreEventBus([recorder]);
    const envelopes: CoreEventEnvelope[] = [
      envelope(2, { type: 'assistant-message-started', turnId: turnId(1) }),
      envelope(1, { type: 'generate-turn-started', turn: 1, turnId: turnId(1) }),
    ];

    await replayCoreEventEnvelopes(envelopes, bus, { sortBySequence: true });

    expect(recorder.getEvents()).toEqual([
      { type: 'generate-turn-started', turn: 1, turnId: turnId(1) },
      { type: 'assistant-message-started', turnId: turnId(1) },
    ]);
  });

  it('skips events when eventFilter returns false and does not consume sequence', async () => {
    const envelopes: CoreEventEnvelope[] = [];
    const sink = createCoreEventLogSink({
      playthroughId: 'pt-filter',
      writer: createMemoryWriter(envelopes),
      now: createClock(1000),
      eventFilter: (event) =>
        event.type !== 'assistant-text-delta'
        && event.type !== 'assistant-reasoning-delta',
    });

    sink.publish({ type: 'generate-turn-started', turn: 1, turnId: turnId(1) });
    // 这两条该被 filter 跳过
    sink.publish({
      type: 'assistant-text-delta',
      turnId: turnId(1),
      stepId: stepId(1, 0),
      batchId: batchId('b1'),
      text: 'hello',
    });
    sink.publish({
      type: 'assistant-reasoning-delta',
      turnId: turnId(1),
      stepId: stepId(1, 0),
      batchId: batchId('b1'),
      text: 'thinking',
    });
    // 这条该正常持久化，且 sequence 必须是 2（不是 4）—— filter 跳过的不消耗 sequence
    sink.publish({ type: 'assistant-message-started', turnId: turnId(1) });
    await sink.flushDurable();

    expect(envelopes.map((e) => ({ sequence: e.sequence, type: e.event.type }))).toEqual([
      { sequence: 1, type: 'generate-turn-started' },
      { sequence: 2, type: 'assistant-message-started' },
    ]);
  });

  it('without eventFilter (default), persists all event types including deltas', async () => {
    const envelopes: CoreEventEnvelope[] = [];
    const sink = createCoreEventLogSink({
      playthroughId: 'pt-no-filter',
      writer: createMemoryWriter(envelopes),
      now: createClock(1000),
      // 不传 eventFilter
    });

    sink.publish({
      type: 'assistant-text-delta',
      turnId: turnId(1),
      stepId: stepId(1, 0),
      batchId: batchId('b1'),
      text: 'hi',
    });
    sink.publish({
      type: 'assistant-reasoning-delta',
      turnId: turnId(1),
      stepId: stepId(1, 0),
      batchId: batchId('b1'),
      text: 'th',
    });
    await sink.flushDurable();

    expect(envelopes.map((e) => e.event.type)).toEqual([
      'assistant-text-delta',
      'assistant-reasoning-delta',
    ]);
  });
});

function createMemoryWriter(envelopes: CoreEventEnvelope[]): CoreEventLogWriter {
  return {
    async append(envelope) {
      envelopes.push(envelope);
    },
  };
}

function createClock(start: number): () => number {
  let current = start;
  return () => current++;
}

function envelope(
  sequence: number,
  event: CoreEventEnvelope['event'],
): CoreEventEnvelope {
  return {
    schemaVersion: 1,
    sequence,
    occurredAt: sequence,
    playthroughId: 'pt-replay',
    event,
  };
}
