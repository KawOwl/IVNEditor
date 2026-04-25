import type { DebugSnapshot } from '#internal/session-emitter';
import type {
  PromptSnapshot,
  SceneState,
  Sentence,
  ScratchBlock,
} from '#internal/types';
import type { DegradeEvent } from '#internal/narrative-parser-v2';

export type TurnId = string & { readonly __brand: 'TurnId' };
export type StepId = string & { readonly __brand: 'StepId' };
export type BatchId = string & { readonly __brand: 'BatchId' };
export type InputRequestId = string & { readonly __brand: 'InputRequestId' };

export type RuntimeSentence = Exclude<Sentence, { kind: 'scene_change' }>;

export type InputRequest =
  | {
      readonly inputType: 'freetext';
      readonly hint: string | null;
      readonly choices: null;
    }
  | {
      readonly inputType: 'choice';
      readonly hint: string | null;
      readonly choices: readonly string[];
    };

export interface SessionSnapshot {
  readonly turn: number;
  readonly stateVars: Record<string, unknown>;
  readonly memorySnapshot?: Record<string, unknown>;
  readonly currentScene: SceneState;
}

export type SessionCoreEvent =
  | {
      readonly type: 'session-started';
      readonly snapshot: SessionSnapshot;
    }
  | {
      readonly type: 'session-restored';
      readonly restoredFrom: 'idle' | 'generating' | 'waiting-input' | 'finished';
      readonly snapshot: SessionSnapshot;
    }
  | {
      readonly type: 'session-stopped';
      readonly reason: 'user' | 'abort' | 'error';
    }
  | {
      readonly type: 'session-finished';
      readonly reason?: string;
      readonly snapshot: SessionSnapshot;
    }
  | {
      readonly type: 'session-error';
      readonly phase: 'start' | 'generate' | 'receive' | 'restore';
      readonly message: string;
      readonly snapshot?: SessionSnapshot;
    };

export type GenerateCoreEvent =
  | {
      readonly type: 'generate-turn-started';
      readonly turn: number;
      readonly turnId: TurnId;
    }
  | {
      readonly type: 'context-assembled';
      readonly turnId: TurnId;
      readonly promptSnapshot: PromptSnapshot;
    }
  | {
      readonly type: 'assistant-message-started';
      readonly turnId: TurnId;
    }
  | {
      readonly type: 'llm-step-started';
      readonly turnId: TurnId;
      readonly stepId: StepId;
      readonly batchId: BatchId;
      readonly isFollowup: boolean;
    }
  | {
      readonly type: 'assistant-text-delta';
      readonly turnId: TurnId;
      readonly stepId: StepId | null;
      readonly batchId: BatchId | null;
      readonly text: string;
    }
  | {
      readonly type: 'assistant-reasoning-delta';
      readonly turnId: TurnId;
      readonly stepId: StepId | null;
      readonly batchId: BatchId | null;
      readonly text: string;
    }
  | {
      readonly type: 'tool-call-started';
      readonly turnId: TurnId;
      readonly stepId: StepId | null;
      readonly batchId: BatchId | null;
      readonly toolName: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool-call-finished';
      readonly turnId: TurnId;
      readonly stepId: StepId | null;
      readonly batchId: BatchId | null;
      readonly toolName: string;
      readonly output: unknown;
    }
  | {
      readonly type: 'assistant-message-finalized';
      readonly turnId: TurnId;
      readonly finishReason: string;
    }
  | {
      readonly type: 'generate-turn-completed';
      readonly turnId: TurnId;
      readonly finishReason: string;
      readonly preview: string | null;
      readonly snapshot: SessionSnapshot;
    };

export type NarrativeSegmentFinalizedReason =
  | 'generate-complete'
  | 'signal-input-preflush'
  | 'tool-only-step-reasoning';

export type NarrativeCoreEvent =
  | {
      readonly type: 'narrative-batch-emitted';
      readonly turnId: TurnId;
      readonly batchId: BatchId | null;
      readonly sentences: readonly RuntimeSentence[];
      readonly scratches: readonly ScratchBlock[];
      readonly degrades: readonly DegradeEvent[];
      readonly sceneAfter: SceneState;
    }
  | {
      readonly type: 'narrative-segment-finalized';
      readonly turnId: TurnId;
      readonly stepId: StepId | null;
      readonly batchId: BatchId | null;
      readonly reason: NarrativeSegmentFinalizedReason;
      readonly entry: {
        readonly role: 'generate';
        readonly content: string;
        readonly reasoning?: string;
        readonly finishReason?: string;
      };
      readonly sceneAfter: SceneState;
    }
  | {
      readonly type: 'scene-changed';
      readonly turnId: TurnId;
      readonly batchId: BatchId | null;
      readonly scene: SceneState;
      readonly transition?: 'fade' | 'cut' | 'dissolve';
      readonly sentence: Extract<Sentence, { kind: 'scene_change' }>;
    };

export type InputCoreEvent =
  | {
      readonly type: 'signal-input-recorded';
      readonly turnId: TurnId;
      readonly batchId: BatchId | null;
      readonly request: InputRequest;
      readonly sentence: Extract<Sentence, { kind: 'signal_input' }>;
      readonly sceneAfter: SceneState;
    }
  | {
      readonly type: 'waiting-input-started';
      readonly turnId: TurnId;
      readonly requestId: InputRequestId;
      readonly source: 'signal' | 'fallback' | 'restore';
      readonly causedByBatchId: BatchId | null;
      readonly request: InputRequest;
      readonly snapshot: SessionSnapshot;
    }
  | {
      readonly type: 'player-input-recorded';
      readonly turnId: TurnId;
      readonly requestId: InputRequestId | null;
      readonly batchId: BatchId;
      readonly text: string;
      readonly payload: {
        readonly inputType: 'choice' | 'freetext';
        readonly selectedIndex?: number;
      };
      readonly sentence: Extract<Sentence, { kind: 'player_input' }>;
      readonly snapshot: SessionSnapshot;
    };

export type MemoryCoreEvent =
  | {
      readonly type: 'memory-compaction-started';
      readonly turnId: TurnId;
    }
  | {
      readonly type: 'memory-compaction-completed';
      readonly turnId: TurnId;
      readonly snapshot: SessionSnapshot;
    };

export type DiagnosticCoreEvent = {
  readonly type: 'diagnostics-updated';
  readonly diagnostics: DebugSnapshot;
};

export type CoreEvent =
  | SessionCoreEvent
  | GenerateCoreEvent
  | NarrativeCoreEvent
  | InputCoreEvent
  | MemoryCoreEvent
  | DiagnosticCoreEvent;

export interface CoreEventEnvelope {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly occurredAt: number;
  readonly playthroughId: string;
  readonly event: CoreEvent;
}

export interface CoreEventSink {
  publish(event: CoreEvent): void;
}

export interface CoreEventBus extends CoreEventSink {
  flushDurable(): Promise<void>;
}

export function createCoreEventBus(sinks: readonly CoreEventSink[] = []): CoreEventBus {
  return {
    publish(event) {
      for (const sink of sinks) {
        sink.publish(event);
      }
    },
    async flushDurable() {},
  };
}

export function createNoopCoreEventSink(): CoreEventSink {
  return { publish() {} };
}

export function turnId(turn: number): TurnId {
  return `turn-${turn}` as TurnId;
}

export function stepId(turn: number, stepNumber: number): StepId {
  return `turn-${turn}-step-${stepNumber}` as StepId;
}

export function batchId(value: string | null | undefined): BatchId | null {
  return value ? (value as BatchId) : null;
}

export function inputRequestId(turn: number): InputRequestId {
  return `turn-${turn}-input` as InputRequestId;
}

export function createInputRequest(
  hint: string | null,
  choices: readonly string[] | null,
): InputRequest {
  return choices && choices.length > 0
    ? { inputType: 'choice', hint, choices: [...choices] }
    : { inputType: 'freetext', hint, choices: null };
}
