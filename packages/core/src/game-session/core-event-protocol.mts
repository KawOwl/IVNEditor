import type {
  BatchId,
  CoreEvent,
  InputRequestId,
  TurnId,
} from '#internal/game-session/core-events';

export type CoreEventProtocolPhase =
  | 'idle'
  | 'generating'
  | 'generated'
  | 'waiting-input'
  | 'finished'
  | 'stopped';

export interface CoreEventProtocolState {
  readonly phase: CoreEventProtocolPhase;
  readonly turnId: TurnId | null;
  readonly requestId: InputRequestId | null;
  readonly assistantOpen: boolean;
  readonly mainBatchIds: ReadonlySet<BatchId>;
}

export interface CoreEventProtocolViolation {
  readonly index: number;
  readonly eventType: CoreEvent['type'];
  readonly message: string;
}

export interface CoreEventProtocolReport {
  readonly ok: boolean;
  readonly finalState: CoreEventProtocolState;
  readonly violations: readonly CoreEventProtocolViolation[];
}

export const INITIAL_CORE_EVENT_PROTOCOL_STATE: CoreEventProtocolState = {
  phase: 'idle',
  turnId: null,
  requestId: null,
  assistantOpen: false,
  mainBatchIds: new Set(),
};

export function validateCoreEventSequence(
  events: readonly CoreEvent[],
): CoreEventProtocolReport {
  let state = INITIAL_CORE_EVENT_PROTOCOL_STATE;
  const violations: CoreEventProtocolViolation[] = [];

  events.forEach((event, index) => {
    const result = reduceCoreEventProtocol(state, event);
    state = result.state;
    for (const message of result.errors) {
      violations.push({ index, eventType: event.type, message });
    }
  });

  return {
    ok: violations.length === 0,
    finalState: state,
    violations,
  };
}

export function reduceCoreEventProtocol(
  state: CoreEventProtocolState,
  event: CoreEvent,
): { readonly state: CoreEventProtocolState; readonly errors: readonly string[] } {
  const errors: string[] = [];
  let next = state;

  const requireTurn = () => {
    if (state.turnId !== null && 'turnId' in event && event.turnId !== state.turnId) {
      errors.push(`event turnId ${event.turnId} does not match active turn ${state.turnId}`);
    }
  };

  switch (event.type) {
    case 'session-started':
    case 'session-restored':
      next = {
        phase: 'idle',
        turnId: null,
        requestId: null,
        assistantOpen: false,
        mainBatchIds: new Set(),
      };
      break;

    case 'generate-turn-started':
      if (!['idle', 'generated', 'waiting-input'].includes(state.phase)) {
        errors.push(`cannot start generate turn from phase ${state.phase}`);
      }
      next = {
        phase: 'generating',
        turnId: event.turnId,
        requestId: null,
        assistantOpen: false,
        mainBatchIds: new Set(),
      };
      break;

    case 'context-assembled':
      requireTurn();
      if (state.phase !== 'generating') {
        errors.push(`context assembled outside generating phase (${state.phase})`);
      }
      break;

    case 'assistant-message-started':
      requireTurn();
      if (state.phase !== 'generating') {
        errors.push(`assistant message started outside generating phase (${state.phase})`);
      }
      if (state.assistantOpen) {
        errors.push('assistant message is already open');
      }
      next = { ...state, assistantOpen: true };
      break;

    case 'llm-step-started':
      requireTurn();
      if (state.phase !== 'generating') {
        errors.push(`LLM step started outside generating phase (${state.phase})`);
      }
      next = event.isFollowup
        ? state
        : {
            ...state,
            mainBatchIds: new Set([...state.mainBatchIds, event.batchId]),
          };
      break;

    case 'assistant-text-delta':
    case 'assistant-reasoning-delta':
      requireTurn();
      if (state.phase !== 'generating') {
        errors.push(`${event.type} outside generating phase (${state.phase})`);
      }
      if (!state.assistantOpen) {
        errors.push(`${event.type} before assistant-message-started`);
      }
      break;

    case 'tool-call-started':
    case 'tool-call-finished':
    case 'narrative-batch-emitted':
    case 'scene-changed':
    case 'signal-input-recorded':
      requireTurn();
      if (state.phase !== 'generating') {
        errors.push(`${event.type} outside generating phase (${state.phase})`);
      }
      break;

    case 'narrative-segment-finalized':
      requireTurn();
      if (state.phase !== 'generating') {
        errors.push(`narrative finalized outside generating phase (${state.phase})`);
      }
      if (event.batchId && !state.mainBatchIds.has(event.batchId)) {
        errors.push(`narrative finalized with non-main batchId ${event.batchId}`);
      }
      break;

    case 'assistant-message-finalized':
      requireTurn();
      if (!state.assistantOpen) {
        errors.push('assistant-message-finalized without an open assistant message');
      }
      next = { ...state, assistantOpen: false };
      break;

    case 'generate-turn-completed':
      requireTurn();
      if (state.phase !== 'generating') {
        errors.push(`generate completed outside generating phase (${state.phase})`);
      }
      next = {
        ...state,
        phase: 'generated',
        assistantOpen: false,
      };
      break;

    case 'waiting-input-started':
      if (event.source !== 'restore' && state.phase !== 'generated') {
        errors.push(`waiting input started from phase ${state.phase}`);
      }
      next = {
        phase: 'waiting-input',
        turnId: event.turnId,
        requestId: event.requestId,
        assistantOpen: false,
        mainBatchIds: state.mainBatchIds,
      };
      break;

    case 'player-input-recorded':
      requireTurn();
      if (state.phase !== 'waiting-input') {
        errors.push(`player input recorded from phase ${state.phase}`);
      }
      if (event.requestId !== null && state.requestId !== event.requestId) {
        errors.push(`player input requestId ${event.requestId} does not match ${state.requestId}`);
      }
      next = {
        phase: 'idle',
        turnId: null,
        requestId: null,
        assistantOpen: false,
        mainBatchIds: new Set(),
      };
      break;

    case 'memory-compaction-started':
    case 'memory-compaction-completed':
    case 'diagnostics-updated':
      break;

    case 'session-finished':
      next = { ...state, phase: 'finished', assistantOpen: false };
      break;

    case 'session-stopped':
      next = { ...state, phase: 'stopped', assistantOpen: false };
      break;

    case 'session-error':
      next = { ...state, phase: 'stopped', assistantOpen: false };
      break;
  }

  return { state: next, errors };
}
