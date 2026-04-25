import type {
  BatchId,
  CoreEvent,
  InputRequest,
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
  readonly inputRequest: InputRequest | null;
  readonly assistantOpen: boolean;
  readonly mainBatchIds: ReadonlySet<BatchId>;
  readonly pendingSignalBatchId: BatchId | null;
  readonly openToolCalls: readonly string[];
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
  inputRequest: null,
  assistantOpen: false,
  mainBatchIds: new Set(),
  pendingSignalBatchId: null,
  openToolCalls: [],
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
  const requireOpenSession = () => {
    if (
      (state.phase === 'finished' || state.phase === 'stopped') &&
      event.type !== 'session-started' &&
      event.type !== 'session-restored' &&
      event.type !== 'session-stopped'
    ) {
      errors.push(`${event.type} after terminal phase ${state.phase}`);
    }
  };
  const requireMainBatch = (
    batchId: BatchId | null,
    label: string,
    options: { readonly requirePresent?: boolean } = {},
  ) => {
    if (!batchId) {
      if (options.requirePresent) {
        errors.push(`${label} without batchId`);
      }
      return;
    }
    if (!state.mainBatchIds.has(batchId)) {
      errors.push(`${label} with non-main batchId ${batchId}`);
    }
  };

  requireOpenSession();

  switch (event.type) {
    case 'session-started':
    case 'session-restored':
      next = {
        phase: event.type === 'session-restored' && event.restoredFrom === 'finished' ? 'finished' : 'idle',
        turnId: null,
        requestId: null,
        inputRequest: null,
        assistantOpen: false,
        mainBatchIds: new Set(),
        pendingSignalBatchId: null,
        openToolCalls: [],
      };
      break;

    case 'generate-turn-started':
      if (!['idle', 'generated'].includes(state.phase)) {
        errors.push(`cannot start generate turn from phase ${state.phase}`);
      }
      next = {
        phase: 'generating',
        turnId: event.turnId,
        requestId: null,
        inputRequest: null,
        assistantOpen: false,
        mainBatchIds: new Set(),
        pendingSignalBatchId: null,
        openToolCalls: [],
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
      requireMainBatch(event.batchId, event.type);
      break;

    case 'tool-call-started':
      requireTurn();
      if (state.phase !== 'generating') {
        errors.push(`tool-call-started outside generating phase (${state.phase})`);
      }
      requireMainBatch(event.batchId, 'tool-call-started', { requirePresent: true });
      next = {
        ...state,
        openToolCalls: [...state.openToolCalls, toolCallKey(event.batchId, event.toolName)],
      };
      break;

    case 'tool-call-finished': {
      requireTurn();
      if (state.phase !== 'generating') {
        errors.push(`tool-call-finished outside generating phase (${state.phase})`);
      }
      requireMainBatch(event.batchId, 'tool-call-finished', { requirePresent: true });
      const key = toolCallKey(event.batchId, event.toolName);
      const index = state.openToolCalls.indexOf(key);
      if (index === -1) {
        errors.push(`tool-call-finished without matching tool-call-started for ${event.toolName}`);
      } else {
        next = {
          ...state,
          openToolCalls: state.openToolCalls.filter((_, i) => i !== index),
        };
      }
      break;
    }

    case 'narrative-batch-emitted':
    case 'scene-changed':
      requireTurn();
      if (state.phase !== 'generating') {
        errors.push(`${event.type} outside generating phase (${state.phase})`);
      }
      requireMainBatch(event.batchId, event.type);
      break;

    case 'signal-input-recorded':
      requireTurn();
      if (state.phase !== 'generating') {
        errors.push(`signal-input-recorded outside generating phase (${state.phase})`);
      }
      requireMainBatch(event.batchId, 'signal-input-recorded', { requirePresent: true });
      next = { ...state, pendingSignalBatchId: event.batchId };
      break;

    case 'narrative-segment-finalized':
      requireTurn();
      if (state.phase !== 'generating') {
        errors.push(`narrative finalized outside generating phase (${state.phase})`);
      }
      requireMainBatch(event.batchId, 'narrative finalized');
      break;

    case 'assistant-message-finalized':
      requireTurn();
      if (state.phase !== 'generating') {
        errors.push(`assistant-message-finalized outside generating phase (${state.phase})`);
      }
      if (!state.assistantOpen) {
        errors.push('assistant-message-finalized without an open assistant message');
      }
      if (state.openToolCalls.length > 0) {
        errors.push('assistant-message-finalized with open tool calls');
      }
      next = { ...state, assistantOpen: false };
      break;

    case 'generate-turn-completed':
      requireTurn();
      if (state.phase !== 'generating') {
        errors.push(`generate completed outside generating phase (${state.phase})`);
      }
      if (state.assistantOpen) {
        errors.push('generate completed before assistant-message-finalized');
      }
      if (state.openToolCalls.length > 0) {
        errors.push('generate completed with open tool calls');
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
      if (event.source === 'signal') {
        if (!event.causedByBatchId) {
          errors.push('signal waiting input without causedByBatchId');
        } else if (state.pendingSignalBatchId !== event.causedByBatchId) {
          errors.push(
            `waiting input causedByBatchId ${event.causedByBatchId} does not match pending signal ${state.pendingSignalBatchId}`,
          );
        }
      } else if (event.causedByBatchId !== null) {
        errors.push(`${event.source} waiting input should not have causedByBatchId`);
      }
      next = {
        phase: 'waiting-input',
        turnId: event.turnId,
        requestId: event.requestId,
        inputRequest: event.request,
        assistantOpen: false,
        mainBatchIds: state.mainBatchIds,
        pendingSignalBatchId: null,
        openToolCalls: [],
      };
      break;

    case 'player-input-recorded':
      requireTurn();
      if (state.phase !== 'waiting-input') {
        errors.push(`player input recorded from phase ${state.phase}`);
      }
      if (event.requestId === null) {
        errors.push('player input recorded without requestId');
      }
      if (event.requestId !== null && state.requestId !== event.requestId) {
        errors.push(`player input requestId ${event.requestId} does not match ${state.requestId}`);
      }
      validatePlayerInputPayload(state.inputRequest, event, errors);
      next = {
        phase: 'idle',
        turnId: null,
        requestId: null,
        inputRequest: null,
        assistantOpen: false,
        mainBatchIds: new Set(),
        pendingSignalBatchId: null,
        openToolCalls: [],
      };
      break;

    case 'memory-compaction-started':
      if (state.phase !== 'generated') {
        errors.push(`memory compaction started from phase ${state.phase}`);
      }
      break;

    case 'memory-compaction-completed':
      if (state.phase !== 'generated') {
        errors.push(`memory compaction completed from phase ${state.phase}`);
      }
      break;

    case 'diagnostics-updated':
      break;

    case 'session-finished':
      if (state.phase !== 'generated' && state.phase !== 'finished') {
        errors.push(`session finished from phase ${state.phase}`);
      }
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

function toolCallKey(batchId: BatchId | null, toolName: string): string {
  return `${batchId ?? '<none>'}:${toolName}`;
}

function validatePlayerInputPayload(
  request: InputRequest | null,
  event: Extract<CoreEvent, { readonly type: 'player-input-recorded' }>,
  errors: string[],
): void {
  if (!request) {
    errors.push('player input recorded without active input request');
    return;
  }

  if (request.inputType === 'freetext' && event.payload.inputType !== 'freetext') {
    errors.push('choice payload recorded for freetext input request');
    return;
  }

  if (event.payload.inputType !== 'choice') {
    return;
  }

  if (request.inputType !== 'choice') {
    errors.push('choice payload recorded without choice input request');
    return;
  }

  const selectedIndex = event.payload.selectedIndex;
  if (selectedIndex === undefined) {
    errors.push('choice payload missing selectedIndex');
    return;
  }

  const selectedChoice = request.choices[selectedIndex];
  if (selectedChoice === undefined) {
    errors.push(`choice selectedIndex ${selectedIndex} is out of range`);
    return;
  }

  if (selectedChoice !== event.text) {
    errors.push(`choice text "${event.text}" does not match selectedIndex ${selectedIndex}`);
  }
}
