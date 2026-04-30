import type { FinishReason, RunInput, ToolCallRecord } from '#internal/v3/kernel/types';

export type ToolCallMeta = {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
  readonly startedAt: number;
};

export type KernelStateInternal = {
  readonly step: number;
  readonly textBufferThisStep: string;
  readonly textTotal: string;
  readonly toolCallsInFlight: ReadonlyMap<string, ToolCallMeta>;
  readonly toolCallsCompleted: readonly ToolCallRecord[];
  readonly finishReason: FinishReason | null;
  readonly finished: boolean;
};

export const initialState = (_input: RunInput): KernelStateInternal => ({
  step: 0,
  textBufferThisStep: '',
  textTotal: '',
  toolCallsInFlight: new Map(),
  toolCallsCompleted: [],
  finishReason: null,
  finished: false,
});
