import { describe, expect, it } from 'bun:test';
import {
  retryMainNarrative,
  buildRetryMainMessages,
  RETRY_MAIN_NUDGE_CONTENT,
  type RetryMainDeps,
  type RetryMainInput,
  type RetryMainInvoke,
  type RetryMainInvokeResult,
} from '#internal/narrative-retry-main';
import type { ModelMessage } from 'ai';
import type { ParserManifest } from '#internal/narrative-parser-v2';
import type { ParserVerifyResult } from '#internal/narrative-rewrite';

const EMPTY_MANIFEST: ParserManifest = {
  characters: new Set(),
  moodsByChar: new Map(),
  defaultMoodByChar: new Map(),
  backgrounds: new Set(),
};

function makeInput(overrides: Partial<RetryMainInput> = {}): RetryMainInput {
  return {
    rawText: '<scratch>玩家想了想…</scratch>',
    mainPathSystemPrompt: '[ENGINE RULES] 你是 GM…',
    mainPathMessages: [
      { role: 'user', content: '前一轮玩家输入' },
      { role: 'assistant', content: '<narration>前一轮叙事</narration>' },
      { role: 'user', content: '本轮玩家输入：你看见了什么？' },
    ] as ModelMessage[],
    turn: 17,
    ...overrides,
  };
}

function makeInvoke(impl: RetryMainInvoke): RetryMainInvoke {
  return impl;
}

function makeVerify(impl: (text: string) => ParserVerifyResult) {
  return (text: string, _manifest: ParserManifest): ParserVerifyResult => impl(text);
}

describe('retryMainNarrative', () => {
  it('skip-empty: rawText 全空白 → 直接返回，不调 invoke', async () => {
    let invoked = 0;
    const result = await retryMainNarrative(
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

  it('skip-aborted: abortSignal 已 abort → 直接返回', async () => {
    const ac = new AbortController();
    ac.abort();
    let invoked = 0;
    const result = await retryMainNarrative(
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

  it('ok: 单次 invoke 成功 + 二次校验 sentenceCount > 0', async () => {
    const result = await retryMainNarrative(makeInput(), {
      invoke: makeInvoke(async () => ({
        text: '<narration>她抬眼看向你，没有说话。</narration>',
        finishReason: 'stop',
        model: 'deepseek-chat',
        inputTokens: 2000,
        outputTokens: 30,
      })),
      verifyParse: makeVerify(() => ({ sentenceCount: 1, scratchCount: 0, degrades: [] })),
      parserManifest: EMPTY_MANIFEST,
    });
    expect(result.status).toBe('ok');
    expect(result.text).toBe('<narration>她抬眼看向你，没有说话。</narration>');
    expect(result.attempts).toBe(1);
    expect(result.fallbackReason).toBeNull();
    expect(result.model).toBe('deepseek-chat');
    expect(result.inputTokens).toBe(2000);
    expect(result.outputTokens).toBe(30);
    expect(result.verified).toEqual({ sentenceCount: 1, scratchCount: 0, degrades: [] });
  });

  it('fallback: invoke api-error → status=fallback, fallbackReason=api-error', async () => {
    const result = await retryMainNarrative(makeInput(), {
      invoke: makeInvoke(async () => {
        throw new Error('rate limited');
      }),
      verifyParse: makeVerify(() => ({ sentenceCount: 0, scratchCount: 0, degrades: [] })),
      parserManifest: EMPTY_MANIFEST,
    });
    expect(result.status).toBe('fallback');
    expect(result.fallbackReason).toBe('api-error');
    expect(result.text).toBe('<scratch>玩家想了想…</scratch>'); // fallback 到 raw
    expect(result.attempts).toBe(1);
  });

  it('fallback: 二次校验 sentenceCount=0 → status=fallback, fallbackReason=second-parse-failed', async () => {
    const result = await retryMainNarrative(makeInput(), {
      invoke: makeInvoke(async () => ({
        text: '<scratch>retry-main 也只写了内心戏</scratch>',
        finishReason: 'stop',
        inputTokens: 1500,
        outputTokens: 20,
      })),
      verifyParse: makeVerify(() => ({ sentenceCount: 0, scratchCount: 1, degrades: [] })),
      parserManifest: EMPTY_MANIFEST,
    });
    expect(result.status).toBe('fallback');
    expect(result.fallbackReason).toBe('second-parse-failed');
    expect(result.text).toBe('<scratch>retry-main 也只写了内心戏</scratch>');
    expect(result.attempts).toBe(1);
    expect(result.verified).toEqual({ sentenceCount: 0, scratchCount: 1, degrades: [] });
  });

  it('messages 构造：在 main path messages 末尾追加 assistant(raw) + user(nudge)', () => {
    const main: ModelMessage[] = [
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'B' },
      { role: 'user', content: 'C' },
    ];
    const out = buildRetryMainMessages(main, '<scratch>raw</scratch>');
    expect(out.length).toBe(5);
    expect(out[0]).toEqual({ role: 'user', content: 'A' });
    expect(out[1]).toEqual({ role: 'assistant', content: 'B' });
    expect(out[2]).toEqual({ role: 'user', content: 'C' });
    expect(out[3]).toEqual({ role: 'assistant', content: '<scratch>raw</scratch>' });
    expect(out[4]).toEqual({ role: 'user', content: RETRY_MAIN_NUDGE_CONTENT });
  });

  it('messages 构造：rawText 全空白时不追加 assistant message，只追 nudge', () => {
    const main: ModelMessage[] = [{ role: 'user', content: 'A' }];
    const out = buildRetryMainMessages(main, '   ');
    expect(out.length).toBe(2);
    expect(out[0]).toEqual({ role: 'user', content: 'A' });
    expect(out[1]).toEqual({ role: 'user', content: RETRY_MAIN_NUDGE_CONTENT });
  });

  it('invoke 调用时 messages 等同于 buildRetryMainMessages 的输出', async () => {
    let capturedMessages: ReadonlyArray<ModelMessage> | null = null;
    const input = makeInput();
    await retryMainNarrative(input, {
      invoke: makeInvoke(async (opts) => {
        capturedMessages = opts.messages;
        return {
          text: '<narration>...</narration>',
          finishReason: 'stop',
        };
      }),
      verifyParse: makeVerify(() => ({ sentenceCount: 1, scratchCount: 0, degrades: [] })),
      parserManifest: EMPTY_MANIFEST,
    });
    const expected = buildRetryMainMessages(input.mainPathMessages, input.rawText);
    expect(capturedMessages).toEqual(expected);
  });

  it('trace span：invoke 成功时 end 收到 text + finishReason + tokens，无 error/fallbackReason', async () => {
    const events: Array<{ stage: 'start' | 'end'; payload: unknown }> = [];
    await retryMainNarrative(makeInput(), {
      invoke: makeInvoke(async () => ({
        text: '<narration>ok</narration>',
        finishReason: 'stop',
        inputTokens: 100,
        outputTokens: 10,
      })),
      verifyParse: makeVerify(() => ({ sentenceCount: 1, scratchCount: 0, degrades: [] })),
      parserManifest: EMPTY_MANIFEST,
      trace: {
        start: (input) => {
          events.push({ stage: 'start', payload: input });
          return {
            end: (opts) => events.push({ stage: 'end', payload: opts }),
          };
        },
      },
    });
    expect(events.length).toBe(2);
    expect(events[0]?.stage).toBe('start');
    const startPayload = events[0]?.payload as { systemPrompt: string; messageCount: number; rawTextLength: number };
    expect(startPayload.systemPrompt).toBe('[ENGINE RULES] 你是 GM…');
    expect(startPayload.messageCount).toBe(5);
    expect(startPayload.rawTextLength).toBe('<scratch>玩家想了想…</scratch>'.length);
    expect(events[1]?.stage).toBe('end');
    const endPayload = events[1]?.payload as Record<string, unknown>;
    expect(endPayload.text).toBe('<narration>ok</narration>');
    expect(endPayload.finishReason).toBe('stop');
    expect(endPayload.fallbackReason).toBeUndefined();
  });

  it('trace span：fallback (second-parse-failed) 时 end 带 fallbackReason', async () => {
    const events: Array<{ stage: 'end'; payload: Record<string, unknown> }> = [];
    await retryMainNarrative(makeInput(), {
      invoke: makeInvoke(async () => ({
        text: '<scratch>仍然没正文</scratch>',
        finishReason: 'stop',
      })),
      verifyParse: makeVerify(() => ({ sentenceCount: 0, scratchCount: 1, degrades: [] })),
      parserManifest: EMPTY_MANIFEST,
      trace: {
        start: () => ({
          end: (opts) => events.push({ stage: 'end', payload: opts as Record<string, unknown> }),
        }),
      },
    });
    expect(events.length).toBe(1);
    expect(events[0]?.payload.fallbackReason).toBe('second-parse-failed');
  });

  it('maxRetries=1: 第一次 invoke verify 失败 → 重试一次', async () => {
    let invokeCount = 0;
    const result = await retryMainNarrative(makeInput(), {
      invoke: makeInvoke(async () => {
        invokeCount += 1;
        return {
          text: '<scratch>仍然</scratch>',
          finishReason: 'stop',
        };
      }),
      verifyParse: makeVerify(() => ({ sentenceCount: 0, scratchCount: 1, degrades: [] })),
      parserManifest: EMPTY_MANIFEST,
      maxRetries: 1,
    });
    expect(invokeCount).toBe(2);
    expect(result.attempts).toBe(2);
    expect(result.status).toBe('fallback');
  });

  it('maxRetries=0 (默认): verify 失败不重试', async () => {
    let invokeCount = 0;
    await retryMainNarrative(makeInput(), {
      invoke: makeInvoke(async () => {
        invokeCount += 1;
        return { text: '<scratch>x</scratch>', finishReason: 'stop' };
      }),
      verifyParse: makeVerify(() => ({ sentenceCount: 0, scratchCount: 1, degrades: [] })),
      parserManifest: EMPTY_MANIFEST,
    });
    expect(invokeCount).toBe(1);
  });

  it('累计 token：多次 invoke 时 inputTokens / outputTokens 累加', async () => {
    let n = 0;
    const result = await retryMainNarrative(makeInput(), {
      invoke: makeInvoke(async () => {
        n += 1;
        return {
          text: '<scratch>x</scratch>',
          finishReason: 'stop',
          inputTokens: 100 * n,
          outputTokens: 10 * n,
        };
      }),
      verifyParse: makeVerify(() => ({ sentenceCount: 0, scratchCount: 1, degrades: [] })),
      parserManifest: EMPTY_MANIFEST,
      maxRetries: 1,
    });
    expect(result.inputTokens).toBe(100 + 200);
    expect(result.outputTokens).toBe(10 + 20);
  });
});
