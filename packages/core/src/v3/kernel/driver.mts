import { streamText } from 'ai';

import type {
  FinishReason,
  KernelEvent,
  RunInput,
  SourceEvent,
  TokenUsage,
} from '#internal/v3/kernel/types';
import { initialState } from '#internal/v3/kernel/state';
import { step } from '#internal/v3/kernel/step';

const KNOWN_FINISH_REASONS: ReadonlySet<FinishReason> = new Set([
  'stop',
  'tool-calls',
  'length',
  'content-filter',
  'error',
  'other',
  'unknown',
]);

const normalizeFinishReason = (raw: string | undefined): FinishReason => {
  if (raw && KNOWN_FINISH_REASONS.has(raw as FinishReason)) {
    return raw as FinishReason;
  }
  return 'unknown';
};

const normalizeUsage = (
  u:
    | {
        inputTokens?: number;
        outputTokens?: number;
        reasoningTokens?: number;
      }
    | undefined,
): TokenUsage => ({
  inputTokens: u?.inputTokens ?? 0,
  outputTokens: u?.outputTokens ?? 0,
  ...(u?.reasoningTokens !== undefined
    ? { reasoningTokens: u.reasoningTokens }
    : {}),
});

// async generator。Q10 阶段（搁置 tool）的 text-only 实现。
// 拉 fullStream 仅认 text-delta / reasoning-delta；tool-call / tool-result
// part 直接跳过（reducer 层若收到 tool source 也会 throw，双层防御）。
// 收尾从 stream.finishReason / stream.usage promise 取，喂 llm-step-finish
// → reducer emit step-finished + final + finish。
//
// system 字符串由 caller 提供（已拼好）。kernel 不知 Section / Budget。
export async function* run(input: RunInput): AsyncIterable<KernelEvent> {
  let state = initialState(input);
  state = { ...state, step: 1 };
  yield { type: 'step-started', step: state.step };

  const stream = streamText({
    model: input.model,
    system: input.system,
    messages: [...input.messages],
    abortSignal: input.abortSignal,
  });

  for await (const part of stream.fullStream) {
    let src: SourceEvent | null = null;
    if (part.type === 'text-delta') {
      src = { kind: 'llm-text-delta', text: part.text };
    } else if (part.type === 'reasoning-delta') {
      src = { kind: 'llm-reasoning-delta', text: part.text };
    }
    if (!src) continue;

    const r = step(state, src);
    state = r.state;
    for (const d of r.decisions) {
      if (d.kind === 'emit') yield d.event;
    }
  }

  const reason = normalizeFinishReason(await stream.finishReason);
  const usage = normalizeUsage(await stream.usage);

  const finishR = step(state, { kind: 'llm-step-finish', reason, usage });
  state = finishR.state;
  for (const d of finishR.decisions) {
    if (d.kind === 'emit') yield d.event;
    else if (d.kind === 'finish') return;
  }
}
