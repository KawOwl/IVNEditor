import type {
  Decision,
  KernelEvent,
  SourceEvent,
} from '#internal/v3/kernel/types';
import type { KernelStateInternal } from '#internal/v3/kernel/state';

export type StepResult = {
  readonly state: KernelStateInternal;
  readonly decisions: readonly Decision[];
};

const emit = (event: KernelEvent): Decision => ({ kind: 'emit', event });
const FINISH: Decision = { kind: 'finish' };

// 纯 reducer。Q10 阶段（搁置 tool 路径）的 text-only 实现。
// tool-call / tool-result / tool-error 落到这里会 throw —— driver 层亦不会
// fullStream 翻译这些 part（同样跳过），双层防御。
export const step = (
  state: KernelStateInternal,
  src: SourceEvent,
): StepResult => {
  switch (src.kind) {
    case 'llm-text-delta':
      return {
        state: {
          ...state,
          textBufferThisStep: state.textBufferThisStep + src.text,
          textTotal: state.textTotal + src.text,
        },
        decisions: [emit({ type: 'text-delta', text: src.text })],
      };

    case 'llm-reasoning-delta':
      return {
        state,
        decisions: [emit({ type: 'reasoning-delta', text: src.text })],
      };

    case 'llm-step-finish': {
      const next: KernelStateInternal = {
        ...state,
        finishReason: src.reason,
        finished: true,
      };
      return {
        state: next,
        decisions: [
          emit({
            type: 'step-finished',
            finishReason: src.reason,
            usage: src.usage,
          }),
          emit({
            type: 'final',
            finishReason: src.reason,
            toolCallsCompleted: state.toolCallsCompleted,
            text: state.textTotal,
          }),
          FINISH,
        ],
      };
    }

    case 'llm-tool-call':
    case 'tool-result':
    case 'tool-error':
      throw new Error(
        `step: ${src.kind} not implemented (Q10 tool path deferred). 见 docs/refactor/v3-effect-migration-plan.md`,
      );
  }
};
