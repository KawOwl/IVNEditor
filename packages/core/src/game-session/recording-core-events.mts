import type {
  CoreEvent,
  CoreEventEnvelope,
  CoreEventSink,
} from '#internal/game-session/core-events';

export interface RecordingCoreEventSink extends CoreEventSink {
  getEvents(): readonly CoreEvent[];
  getEnvelopes(): readonly CoreEventEnvelope[];
  reset(): void;
}

export function createRecordingCoreEventSink(options: {
  readonly playthroughId: string;
  readonly now?: () => number;
}): RecordingCoreEventSink {
  const envelopes: CoreEventEnvelope[] = [];
  const now = options.now ?? (() => Date.now());

  return {
    publish(event) {
      envelopes.push({
        schemaVersion: 1,
        sequence: envelopes.length + 1,
        occurredAt: now(),
        playthroughId: options.playthroughId,
        event: cloneValue(event),
      });
    },

    getEvents() {
      return envelopes.map((envelope) => cloneValue(envelope.event));
    },

    getEnvelopes() {
      return envelopes.map((envelope) => cloneValue(envelope));
    },

    reset() {
      envelopes.length = 0;
    },
  };
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}
