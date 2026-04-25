import { describe, expect, it } from 'bun:test';
import {
  createCoreEventBus,
  createRecordingCoreEventSink,
  replayCoreEventEnvelopes,
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
