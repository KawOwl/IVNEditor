import { describe, it, expect } from 'bun:test';

import { step } from '#internal/v3/kernel/step';
import type { KernelStateInternal } from '#internal/v3/kernel/state';
import type { TokenUsage } from '#internal/v3/kernel/types';

const baseState: KernelStateInternal = {
  step: 1,
  textBufferThisStep: '',
  textTotal: '',
  toolCallsInFlight: new Map(),
  toolCallsCompleted: [],
  finishReason: null,
  finished: false,
};

describe('step reducer (Q10 text-only)', () => {
  it('llm-text-delta 累加 textBufferThisStep + textTotal', () => {
    const r1 = step(baseState, { kind: 'llm-text-delta', text: 'hello' });
    expect(r1.state.textBufferThisStep).toBe('hello');
    expect(r1.state.textTotal).toBe('hello');
    expect(r1.decisions).toEqual([
      { kind: 'emit', event: { type: 'text-delta', text: 'hello' } },
    ]);

    const r2 = step(r1.state, { kind: 'llm-text-delta', text: ' world' });
    expect(r2.state.textBufferThisStep).toBe('hello world');
    expect(r2.state.textTotal).toBe('hello world');
  });

  it('llm-reasoning-delta 透传，不动 state', () => {
    const r = step(baseState, { kind: 'llm-reasoning-delta', text: '想' });
    expect(r.state).toEqual(baseState);
    expect(r.decisions).toEqual([
      { kind: 'emit', event: { type: 'reasoning-delta', text: '想' } },
    ]);
  });

  it('llm-step-finish stop → emit step-finished + final + finish', () => {
    const usage: TokenUsage = { inputTokens: 10, outputTokens: 20 };
    const stateWithText: KernelStateInternal = {
      ...baseState,
      textTotal: 'hi',
    };
    const r = step(stateWithText, {
      kind: 'llm-step-finish',
      reason: 'stop',
      usage,
    });
    expect(r.state.finishReason).toBe('stop');
    expect(r.state.finished).toBe(true);
    expect(r.decisions).toEqual([
      {
        kind: 'emit',
        event: { type: 'step-finished', finishReason: 'stop', usage },
      },
      {
        kind: 'emit',
        event: {
          type: 'final',
          finishReason: 'stop',
          toolCallsCompleted: [],
          text: 'hi',
        },
      },
      { kind: 'finish' },
    ]);
  });

  it('llm-step-finish length → finished true，final.finishReason=length', () => {
    const usage: TokenUsage = { inputTokens: 10, outputTokens: 100 };
    const r = step(baseState, {
      kind: 'llm-step-finish',
      reason: 'length',
      usage,
    });
    expect(r.state.finished).toBe(true);
    const finalDecision = r.decisions.find(
      (d): d is { kind: 'emit'; event: { type: 'final'; finishReason: 'length' } & Record<string, unknown> } =>
        d.kind === 'emit' && d.event.type === 'final',
    );
    expect(finalDecision?.event.finishReason).toBe('length');
  });

  it('llm-step-finish unknown → finished true，原样透传 finishReason', () => {
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    const r = step(baseState, {
      kind: 'llm-step-finish',
      reason: 'unknown',
      usage,
    });
    expect(r.state.finishReason).toBe('unknown');
  });

  it('llm-tool-call throws (Q10 deferred)', () => {
    expect(() =>
      step(baseState, {
        kind: 'llm-tool-call',
        callId: 'c1',
        name: 't',
        args: {},
      }),
    ).toThrow(/Q10/);
  });

  it('tool-result throws (Q10 deferred)', () => {
    expect(() =>
      step(baseState, { kind: 'tool-result', callId: 'c1', output: {} }),
    ).toThrow(/Q10/);
  });

  it('tool-error throws (Q10 deferred)', () => {
    expect(() =>
      step(baseState, { kind: 'tool-error', callId: 'c1', error: 'oops' }),
    ).toThrow(/Q10/);
  });
});
