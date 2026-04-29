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
  /**
   * 决定是否把某个 event 写入持久化日志。返回 false → 该 event 被跳过，
   * sequence 也不消耗。
   *
   * 缺省（不传）→ 全部 event 都写入（保持向后兼容）。
   *
   * 主要用例：跳过流式 chunk（assistant-reasoning-delta / assistant-text-delta），
   * 它们已通过 WebSocket sink 推送给客户端，不需要进 db。详见
   * 2026-04-27 压力负载分析的链条 1+2 根因分析。
   */
  readonly eventFilter?: (event: CoreEvent) => boolean;
}

export interface CoreEventReplayOptions {
  readonly sortBySequence?: boolean;
}

export function createCoreEventLogSink(options: CoreEventLogSinkOptions): CoreEventLogSink {
  const now = options.now ?? (() => Date.now());
  const onError = options.onError ?? logCoreEventLogError;
  const eventFilter = options.eventFilter;
  let sequence = options.initialSequence ?? 0;
  let tail = Promise.resolve();

  return {
    publish(event) {
      // filter 在 envelope 构造前就决定，跳过的 event 不消耗 sequence —— 这样
      // sequence 仍然只标识"持久化层认知中的事件序号"，跨重启读 db 是连续的。
      if (eventFilter && !eventFilter(event)) return;

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
