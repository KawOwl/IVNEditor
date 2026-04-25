import type {
  CoreEvent,
  CoreEventEnvelope,
  InputRequest,
  SessionSnapshot,
} from '#internal/game-session/core-events';
import { createInputRequest } from '#internal/game-session/core-events';
import type { SceneState } from '#internal/types';

export type CoreEventLogRestoreStatus = 'idle' | 'waiting-input' | 'finished';

export interface CoreEventLogRestoreState {
  readonly status: CoreEventLogRestoreStatus;
  readonly turn: number;
  readonly stateVars: Record<string, unknown>;
  readonly memorySnapshot: Record<string, unknown> | null;
  readonly currentScene: SceneState;
  readonly inputHint: string | null;
  readonly inputType: 'freetext' | 'choice';
  readonly choices: string[] | null;
}

export interface CoreEventLogRestoreOptions {
  readonly sortBySequence?: boolean;
}

interface GeneratedCheckpoint {
  readonly snapshot: SessionSnapshot;
  readonly request: InputRequest | null;
}

/**
 * Fold a CoreEvent log into the stable state needed by GameSession.restore().
 *
 * This is deliberately a restore reducer, not a UI replay projection:
 * - `waiting-input-started` means restore should wait with that request.
 * - `player-input-recorded` means the request was consumed, so restore should
 *   continue from idle and generate the next turn.
 * - a completed generate without a persisted waiting event is promoted to a
 *   waiting-input restore point using the recorded signal request or freetext
 *   fallback.
 * - an in-flight generate rolls back to the last stable checkpoint because the
 *   LLM stream itself cannot be resumed.
 */
export function deriveCoreEventRestoreState(
  events: readonly CoreEvent[],
): CoreEventLogRestoreState | null {
  let stable: CoreEventLogRestoreState | null = null;
  let pendingSignalRequest: InputRequest | null = null;
  let generated: GeneratedCheckpoint | null = null;
  let generating = false;

  for (const event of events) {
    switch (event.type) {
      case 'session-started':
        stable = stateFromSnapshot('idle', event.snapshot);
        pendingSignalRequest = null;
        generated = null;
        generating = false;
        break;

      case 'session-restored':
        stable = stateFromSnapshot(
          event.restoredFrom === 'finished' ? 'finished' : 'idle',
          event.snapshot,
        );
        pendingSignalRequest = null;
        generated = null;
        generating = false;
        break;

      case 'generate-turn-started':
        pendingSignalRequest = null;
        generated = null;
        generating = true;
        break;

      case 'signal-input-recorded':
        pendingSignalRequest = event.request;
        break;

      case 'generate-turn-completed':
        generated = {
          snapshot: cloneSnapshot(event.snapshot),
          request: pendingSignalRequest ? cloneInputRequest(pendingSignalRequest) : null,
        };
        generating = false;
        break;

      case 'memory-compaction-completed':
        if (generated) {
          generated = {
            snapshot: cloneSnapshot(event.snapshot),
            request: generated.request,
          };
        }
        break;

      case 'waiting-input-started':
        stable = stateFromSnapshot('waiting-input', event.snapshot, event.request);
        pendingSignalRequest = null;
        generated = null;
        generating = false;
        break;

      case 'player-input-recorded':
        stable = stateFromSnapshot('idle', event.snapshot);
        pendingSignalRequest = null;
        generated = null;
        generating = false;
        break;

      case 'session-finished':
        stable = stateFromSnapshot('finished', event.snapshot);
        pendingSignalRequest = null;
        generated = null;
        generating = false;
        break;

      case 'session-error':
        if (event.snapshot && !stable) {
          stable = stateFromSnapshot('idle', event.snapshot);
        }
        generated = null;
        generating = false;
        break;

      case 'session-stopped':
        generated = null;
        generating = false;
        break;

      default:
        break;
    }
  }

  if (generated) {
    return stateFromSnapshot(
      'waiting-input',
      generated.snapshot,
      generated.request ?? createInputRequest(null, null),
    );
  }

  // If the log ends mid-generate, keep the last stable checkpoint. Retrying the
  // interrupted LLM turn is safer than pretending a half stream reached receive.
  if (generating) return stable ? cloneRestoreState(stable) : null;
  return stable ? cloneRestoreState(stable) : null;
}

export function deriveCoreEventLogRestoreState(
  envelopes: readonly CoreEventEnvelope[],
  options: CoreEventLogRestoreOptions = {},
): CoreEventLogRestoreState | null {
  const ordered = options.sortBySequence
    ? [...envelopes].sort((a, b) => a.sequence - b.sequence)
    : envelopes;

  const events = ordered.map((envelope) => {
    if (envelope.schemaVersion !== 1) {
      throw new Error(`Unsupported CoreEvent envelope schemaVersion: ${envelope.schemaVersion}`);
    }
    return envelope.event;
  });

  return deriveCoreEventRestoreState(events);
}

function stateFromSnapshot(
  status: CoreEventLogRestoreStatus,
  snapshot: SessionSnapshot,
  request?: InputRequest | null,
): CoreEventLogRestoreState {
  const input = requestToState(request ?? null);
  return {
    status,
    turn: snapshot.turn,
    stateVars: cloneRecord(snapshot.stateVars),
    memorySnapshot: snapshot.memorySnapshot ? cloneRecord(snapshot.memorySnapshot) : null,
    currentScene: copyScene(snapshot.currentScene),
    ...input,
  };
}

function requestToState(
  request: InputRequest | null,
): Pick<CoreEventLogRestoreState, 'inputHint' | 'inputType' | 'choices'> {
  if (!request || request.inputType === 'freetext') {
    return {
      inputHint: request?.hint ?? null,
      inputType: 'freetext',
      choices: null,
    };
  }

  return {
    inputHint: request.hint,
    inputType: 'choice',
    choices: [...request.choices],
  };
}

function cloneRestoreState(state: CoreEventLogRestoreState): CoreEventLogRestoreState {
  return {
    ...state,
    stateVars: cloneRecord(state.stateVars),
    memorySnapshot: state.memorySnapshot ? cloneRecord(state.memorySnapshot) : null,
    currentScene: copyScene(state.currentScene),
    choices: state.choices ? [...state.choices] : null,
  };
}

function cloneSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  return {
    turn: snapshot.turn,
    stateVars: cloneRecord(snapshot.stateVars),
    memorySnapshot: snapshot.memorySnapshot ? cloneRecord(snapshot.memorySnapshot) : undefined,
    currentScene: copyScene(snapshot.currentScene),
  };
}

function cloneInputRequest(request: InputRequest): InputRequest {
  return request.inputType === 'choice'
    ? { ...request, choices: [...request.choices] }
    : { ...request };
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}

function copyScene(scene: SceneState): SceneState {
  return {
    background: scene.background,
    sprites: scene.sprites.map((sprite) => ({ ...sprite })),
  };
}
