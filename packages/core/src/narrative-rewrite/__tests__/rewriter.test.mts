import { describe, expect, it } from 'bun:test';
import {
  rewriteNarrative,
  type RewriteDeps,
  type RewriteInput,
  type RewriteInvoke,
  type RewriteInvokeResult,
  type ParserVerifyResult,
  type RewriteTraceHook,
  type RewriteTraceSpan,
} from '#internal/narrative-rewrite';
import type { ParserManifest } from '#internal/narrative-parser-v2';

const EMPTY_MANIFEST: ParserManifest = {
  characters: new Set(),
  moodsByChar: new Map(),
  defaultMoodByChar: new Map(),
  backgrounds: new Set(),
};

function makeInput(overrides: Partial<RewriteInput> = {}): RewriteInput {
  return {
    rawText: 'raw GM 这一轮的输出',
    parserView: {
      sentences: [],
      scratchCount: 0,
      degrades: [],
      looksBroken: true,
    },
    manifest: {
      characterIds: [],
      backgroundIds: [],
      moodsByCharacter: {},
    },
    turn: 12,
    ...overrides,
  };
}

function makeInvoke(impl: RewriteInvoke): RewriteInvoke {
  return impl;
}

function makeVerify(impl: (text: string) => ParserVerifyResult) {
  return (text: string, _manifest: ParserManifest): ParserVerifyResult => impl(text);
}

describe('rewriteNarrative', () => {
  it('skip-empty: rawText 为空白时直接返回不调 invoke', async () => {
    let invoked = 0;
    const result = await rewriteNarrative(
      makeInput({ rawText: '   \n  ' }),
      {
        invoke: makeInvoke(async () => {
          invoked += 1;
          throw new Error('should not be called');
        }),
        verifyParse: makeVerify(() => ({ sentenceCount: 0, scratchCount: 0, degrades: [] })),
        parserManifest: EMPTY_MANIFEST,
      },
    );
    expect(result.status).toBe('skipped-empty');
    expect(result.text).toBe('   \n  ');
    expect(result.attempts).toBe(0);
    expect(invoked).toBe(0);
  });

  it('skip-aborted: abortSignal 已 abort 时直接返回', async () => {
    const ac = new AbortController();
    ac.abort();
    let invoked = 0;
    const result = await rewriteNarrative(
      makeInput({ abortSignal: ac.signal }),
      {
        invoke: makeInvoke(async () => {
          invoked += 1;
          throw new Error('should not be called');
        }),
        verifyParse: makeVerify(() => ({ sentenceCount: 0, scratchCount: 0, degrades: [] })),
        parserManifest: EMPTY_MANIFEST,
      },
    );
    expect(result.status).toBe('skipped-aborted');
    expect(invoked).toBe(0);
  });

  it('ok: 单次 invoke 成功 + 二次校验通过', async () => {
    const result = await rewriteNarrative(makeInput(), {
      invoke: makeInvoke(async () => ({
        text: '<narration>重写后的叙事</narration>',
        finishReason: 'stop',
        model: 'deepseek-chat',
        inputTokens: 1000,
        outputTokens: 50,
      })),
      verifyParse: makeVerify(() => ({ sentenceCount: 1, scratchCount: 0, degrades: [] })),
      parserManifest: EMPTY_MANIFEST,
    });
    expect(result.status).toBe('ok');
    expect(result.text).toBe('<narration>重写后的叙事</narration>');
    expect(result.attempts).toBe(1);
    expect(result.fallbackReason).toBeNull();
    expect(result.model).toBe('deepseek-chat');
    expect(result.inputTokens).toBe(1000);
    expect(result.outputTokens).toBe(50);
    expect(result.verified).toEqual({ sentenceCount: 1, scratchCount: 0, degrades: [] });
  });

  it('fallback (api-error): invoke 抛错 → status=fallback, fallbackReason=api-error', async () => {
    const result = await rewriteNarrative(makeInput(), {
      invoke: makeInvoke(async () => {
        throw new Error('network down');
      }),
      verifyParse: makeVerify(() => ({ sentenceCount: 0, scratchCount: 0, degrades: [] })),
      parserManifest: EMPTY_MANIFEST,
    });
    expect(result.status).toBe('fallback');
    expect(result.fallbackReason).toBe('api-error');
    expect(result.text).toBe('raw GM 这一轮的输出'); // fallback 到 raw
    expect(result.attempts).toBe(1);
  });

  it('fallback (api-error) 不重试 —— maxRetries=1 仍只 invoke 1 次', async () => {
    let invokeCount = 0;
    const result = await rewriteNarrative(makeInput(), {
      invoke: makeInvoke(async () => {
        invokeCount += 1;
        throw new Error('flaky');
      }),
      verifyParse: makeVerify(() => ({ sentenceCount: 0, scratchCount: 0, degrades: [] })),
      parserManifest: EMPTY_MANIFEST,
      maxRetries: 1,
    });
    expect(invokeCount).toBe(1);
    expect(result.fallbackReason).toBe('api-error');
  });

  it('fallback (second-parse-failed): invoke 成功但二次校验 0 sentence，maxRetries=0 不重试', async () => {
    let invokeCount = 0;
    const result = await rewriteNarrative(makeInput(), {
      invoke: makeInvoke(async () => {
        invokeCount += 1;
        return {
          text: '空白输出',
          finishReason: 'stop',
        };
      }),
      verifyParse: makeVerify(() => ({ sentenceCount: 0, scratchCount: 0, degrades: [] })),
      parserManifest: EMPTY_MANIFEST,
    });
    expect(invokeCount).toBe(1);
    expect(result.status).toBe('fallback');
    expect(result.fallbackReason).toBe('second-parse-failed');
    expect(result.text).toBe('空白输出'); // 用最近一次 rewrite 输出，不是 raw
    expect(result.verified).toEqual({ sentenceCount: 0, scratchCount: 0, degrades: [] });
  });

  it('retry: maxRetries=1 + 第一次 0 sentence + 第二次成功 → ok', async () => {
    let invokeCount = 0;
    const result = await rewriteNarrative(makeInput(), {
      invoke: makeInvoke(async () => {
        invokeCount += 1;
        return invokeCount === 1
          ? { text: 'no tags', finishReason: 'stop' }
          : { text: '<narration>second try</narration>', finishReason: 'stop' };
      }),
      verifyParse: makeVerify((text) => ({
        sentenceCount: text.includes('<narration') ? 1 : 0,
        scratchCount: 0,
        degrades: [],
      })),
      parserManifest: EMPTY_MANIFEST,
      maxRetries: 1,
    });
    expect(invokeCount).toBe(2);
    expect(result.status).toBe('ok');
    expect(result.attempts).toBe(2);
    expect(result.text).toBe('<narration>second try</narration>');
  });

  it('retry: maxRetries=1 但两次都失败 → fallback', async () => {
    let invokeCount = 0;
    const result = await rewriteNarrative(makeInput(), {
      invoke: makeInvoke(async () => {
        invokeCount += 1;
        return { text: `attempt ${invokeCount}`, finishReason: 'stop' };
      }),
      verifyParse: makeVerify(() => ({ sentenceCount: 0, scratchCount: 0, degrades: [] })),
      parserManifest: EMPTY_MANIFEST,
      maxRetries: 1,
    });
    expect(invokeCount).toBe(2);
    expect(result.status).toBe('fallback');
    expect(result.fallbackReason).toBe('second-parse-failed');
    expect(result.attempts).toBe(2);
    expect(result.text).toBe('attempt 2');
  });

  it('累计 token usage: 重试时输入/输出 token 累加', async () => {
    let invokeCount = 0;
    const result = await rewriteNarrative(makeInput(), {
      invoke: makeInvoke(async () => {
        invokeCount += 1;
        return {
          text: 'no tags',
          finishReason: 'stop',
          inputTokens: 100,
          outputTokens: 20,
          model: 'm',
        };
      }),
      verifyParse: makeVerify(() => ({ sentenceCount: 0, scratchCount: 0, degrades: [] })),
      parserManifest: EMPTY_MANIFEST,
      maxRetries: 1,
    });
    expect(invokeCount).toBe(2);
    expect(result.inputTokens).toBe(200);
    expect(result.outputTokens).toBe(40);
  });

  it('trace hook: ok 路径 trace.start + span.end 各调一次', async () => {
    const calls: Array<{ phase: 'start' | 'end'; opts: unknown }> = [];
    const trace: RewriteTraceHook = {
      start: (input) => {
        calls.push({ phase: 'start', opts: input });
        const span: RewriteTraceSpan = {
          end: (opts) => calls.push({ phase: 'end', opts }),
        };
        return span;
      },
    };
    await rewriteNarrative(makeInput(), {
      invoke: makeInvoke(async () => ({
        text: '<narration>x</narration>',
        finishReason: 'stop',
        inputTokens: 5,
        outputTokens: 3,
      })),
      verifyParse: makeVerify(() => ({ sentenceCount: 1, scratchCount: 0, degrades: [] })),
      parserManifest: EMPTY_MANIFEST,
      trace,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.phase).toBe('start');
    expect(calls[1]!.phase).toBe('end');
    const end = calls[1]!.opts as { text?: string; fallbackReason?: string };
    expect(end.text).toBe('<narration>x</narration>');
    expect(end.fallbackReason).toBeUndefined();
  });

  it('trace hook: fallback 时 span.end 带 fallbackReason', async () => {
    const calls: Array<{ phase: 'start' | 'end'; opts: unknown }> = [];
    const trace: RewriteTraceHook = {
      start: (input) => {
        calls.push({ phase: 'start', opts: input });
        return { end: (opts) => calls.push({ phase: 'end', opts }) };
      },
    };
    await rewriteNarrative(makeInput(), {
      invoke: makeInvoke(async () => {
        throw new Error('boom');
      }),
      verifyParse: makeVerify(() => ({ sentenceCount: 0, scratchCount: 0, degrades: [] })),
      parserManifest: EMPTY_MANIFEST,
      trace,
    });
    expect(calls).toHaveLength(2);
    const end = calls[1]!.opts as { error?: string; fallbackReason?: string };
    expect(end.error).toBe('boom');
    expect(end.fallbackReason).toBe('api-error');
  });

  it('trace hook: 重试时 start/end 各调用 N 次（每次 attempt 一对）', async () => {
    const calls: Array<{ phase: 'start' | 'end' }> = [];
    const trace: RewriteTraceHook = {
      start: () => {
        calls.push({ phase: 'start' });
        return { end: () => calls.push({ phase: 'end' }) };
      },
    };
    await rewriteNarrative(makeInput(), {
      invoke: makeInvoke(async () => ({ text: 'no tags', finishReason: 'stop' })),
      verifyParse: makeVerify(() => ({ sentenceCount: 0, scratchCount: 0, degrades: [] })),
      parserManifest: EMPTY_MANIFEST,
      trace,
      maxRetries: 1,
    });
    expect(calls.filter((c) => c.phase === 'start')).toHaveLength(2);
    expect(calls.filter((c) => c.phase === 'end')).toHaveLength(2);
  });
});
