import type {
  CoreEvent,
  CoreEventEnvelope,
  CoreEventSink,
} from '#internal/game-session/core-events';

export interface CoreEventLogWriter {
  append(envelope: CoreEventEnvelope): Promise<void>;
}

export interface CoreEventLogSink extends CoreEventSink {
  flushDurable(): Promise<void>;
}

export interface CoreEventLogSinkOptions {
  readonly playthroughId: string;
  readonly writer: CoreEventLogWriter;
  readonly initialSequence?: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown, envelope: CoreEventEnvelope) => void;
}

export interface CoreEventReplayOptions {
  readonly sortBySequence?: boolean;
}

export function createCoreEventLogSink(options: CoreEventLogSinkOptions): CoreEventLogSink {
  const now = options.now ?? (() => Date.now());
  const onError = options.onError ?? logCoreEventLogError;
  let sequence = options.initialSequence ?? 0;
  let tail = Promise.resolve();

  return {
    publish(event) {
      const envelope = createCoreEventEnvelope({
        event,
        playthroughId: options.playthroughId,
        sequence: sequence + 1,
        occurredAt: now(),
      });
      sequence = envelope.sequence;
      tail = tail
        .then(() => options.writer.append(envelope))
        .catch((error) => onError(error, envelope));
    },

    async flushDurable() {
      await tail;
    },
  };
}

export async function replayCoreEventEnvelopes(
  envelopes: readonly CoreEventEnvelope[],
  sink: CoreEventSink,
  options: CoreEventReplayOptions = {},
): Promise<void> {
  const ordered = options.sortBySequence
    ? [...envelopes].sort((a, b) => a.sequence - b.sequence)
    : envelopes;

  for (const envelope of ordered) {
    if (envelope.schemaVersion !== 1) {
      throw new Error(`Unsupported CoreEvent envelope schemaVersion: ${envelope.schemaVersion}`);
    }
    sink.publish(cloneValue(envelope.event));
  }

  await sink.flushDurable?.();
}

function createCoreEventEnvelope(options: {
  readonly event: CoreEvent;
  readonly playthroughId: string;
  readonly sequence: number;
  readonly occurredAt: number;
}): CoreEventEnvelope {
  return {
    schemaVersion: 1,
    sequence: options.sequence,
    occurredAt: options.occurredAt,
    playthroughId: options.playthroughId,
    event: cloneValue(options.event),
  };
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function logCoreEventLogError(error: unknown, envelope: CoreEventEnvelope): void {
  console.error(`[CoreEventLogSink] append failed at sequence ${envelope.sequence}:`, error);
}
