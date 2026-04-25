import type {
  CoreEvent,
  CoreEventSink,
  SessionSnapshot,
} from '#internal/game-session/core-events';
import type { SessionPersistence } from '#internal/game-session/types';
import type { SceneState } from '#internal/types';

type CoreEventOf<T extends CoreEvent['type']> = Extract<CoreEvent, { readonly type: T }>;
type PersistenceHandlers = {
  readonly [K in CoreEvent['type']]?: (
    persistence: SessionPersistence,
    event: CoreEventOf<K>,
  ) => Promise<void>;
};

export interface SessionPersistenceCoreEventSink extends CoreEventSink {
  flushDurable(): Promise<void>;
}

export interface SessionPersistenceCoreEventSinkOptions {
  onError?: (error: unknown, event: CoreEvent) => void;
}

export function createSessionPersistenceCoreEventSink(
  persistence: SessionPersistence,
  options: SessionPersistenceCoreEventSinkOptions = {},
): SessionPersistenceCoreEventSink {
  const onError = options.onError ?? logPersistenceError;
  let tail = Promise.resolve();

  return {
    publish(event) {
      tail = tail
        .then(() => interpretPersistenceEvent(persistence, event))
        .catch((error) => onError(error, event));
    },

    async flushDurable() {
      await tail;
    },
  };
}

export function isSessionPersistenceCoreEvent(event: CoreEvent): boolean {
  switch (event.type) {
    case 'generate-turn-started':
    case 'narrative-segment-finalized':
    case 'generate-turn-completed':
    case 'waiting-input-started':
    case 'signal-input-recorded':
    case 'tool-call-finished':
    case 'player-input-recorded':
    case 'session-finished':
      return true;

    default:
      return false;
  }
}

async function interpretPersistenceEvent(
  persistence: SessionPersistence,
  event: CoreEvent,
): Promise<void> {
  const handler = persistenceHandlers[event.type] as
    | ((persistence: SessionPersistence, event: CoreEvent) => Promise<void>)
    | undefined;
  await handler?.(persistence, event);
}

const persistenceHandlers: PersistenceHandlers = {
  'generate-turn-started': async (persistence, event) => {
    await persistence.onGenerateStart(event.turn);
  },

  'narrative-segment-finalized': async (persistence, event) => {
    await persistence.onNarrativeSegmentFinalized({
      entry: { ...event.entry },
      batchId: event.batchId,
    });
  },

  'generate-turn-completed': async (persistence, event) => {
    await persistence.onGenerateComplete({
      memorySnapshot: cloneRecord(event.snapshot.memorySnapshot),
      preview: event.preview,
      currentScene: copyScene(event.snapshot.currentScene),
    });
  },

  'waiting-input-started': async (persistence, event) => {
    if (event.source === 'restore') return;
    await persistence.onWaitingInput({
      hint: event.request.hint,
      inputType: event.request.inputType,
      choices: event.request.inputType === 'choice' ? [...event.request.choices] : null,
      memorySnapshot: cloneRecord(event.snapshot.memorySnapshot),
      currentScene: copyScene(event.snapshot.currentScene),
      stateVars: cloneRecord(event.snapshot.stateVars),
    });
  },

  'signal-input-recorded': async (persistence, event) => {
    await persistence.onSignalInputRecorded?.({
      hint: event.request.hint ?? '',
      choices: event.request.inputType === 'choice' ? [...event.request.choices] : [],
      batchId: event.batchId,
    });
  },

  'tool-call-finished': async (persistence, event) => {
    if (!event.batchId) return;
    if (event.toolName === 'signal_input_needed' || event.toolName === 'end_scenario') return;
    await persistence.onToolCallRecorded?.({
      toolName: event.toolName,
      input: cloneValue(event.input),
      output: cloneValue(event.output),
      batchId: event.batchId,
    });
  },

  'player-input-recorded': async (persistence, event) => {
    await persistence.onReceiveComplete({
      entry: { role: 'receive', content: event.text },
      stateVars: cloneRecord(event.snapshot.stateVars),
      turn: event.snapshot.turn,
      memorySnapshot: cloneRecord(event.snapshot.memorySnapshot),
      payload: { ...event.payload },
      batchId: event.batchId,
    });
  },

  'session-finished': async (persistence, event) => {
    await persistence.onScenarioFinished?.({ reason: event.reason });
  },
};

function cloneRecord(value: SessionSnapshot['memorySnapshot']): Record<string, unknown> {
  return cloneValue(value ?? {});
}

function copyScene(scene: SceneState): SceneState {
  return {
    background: scene.background,
    sprites: scene.sprites.map((sprite) => ({ ...sprite })),
  };
}

function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

function logPersistenceError(error: unknown, event: CoreEvent): void {
  console.error(`[PersistenceCoreEventSink] ${event.type} failed:`, error);
}
