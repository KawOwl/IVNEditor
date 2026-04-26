import { describe, expect, it } from 'bun:test';
import {
  rewriteNarrative,
  buildRewriteSystemPrompt,
  buildRewriteUserMessage,
  type RewriteDeps,
  type RewriteInput,
  type RewriteInvoke,
  type RewriteInvokeResult,
  type ParserVerifyResult,
  type RewriteTraceHook,
  type RewriteTraceSpan,
} from '#internal/narrative-rewrite';
import {
  ENGINE_RULES_CONTAINER_SPEC_V2,
  ENGINE_RULES_ADHOC_SPEAKER_V2,
  ENGINE_RULES_OUTPUT_DISCIPLINE_V2,
} from '#internal/engine-rules';
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

// 改进 A（2026-04-26）：rewriter system prompt 跟 engine-rules 同源
describe('rewriter system prompt 同源 engine-rules', () => {
  it('包含 engine-rules 容器规范子段（字节子串）', () => {
    const sys = buildRewriteSystemPrompt();
    expect(sys).toContain(ENGINE_RULES_CONTAINER_SPEC_V2);
  });

  it('包含 engine-rules ad-hoc speaker 子段（含三档分级）', () => {
    const sys = buildRewriteSystemPrompt();
    expect(sys).toContain(ENGINE_RULES_ADHOC_SPEAKER_V2);
    // 三档关键字
    expect(sys).toContain('推荐');
    expect(sys).toContain('可接受但不理想');
    expect(sys).toContain('另一人');
    expect(sys).toContain('某人');
  });

  it('包含 engine-rules 输出纪律子段', () => {
    const sys = buildRewriteSystemPrompt();
    expect(sys).toContain(ENGINE_RULES_OUTPUT_DISCIPLINE_V2);
  });

  it('rewriter 专属硬约束（不补剧情等）保留', () => {
    const sys = buildRewriteSystemPrompt();
    expect(sys).toContain('不补剧情');
    expect(sys).toContain('不改剧情走向');
    expect(sys).toContain('允许微调措辞');
  });

  // 修复 trace f6a68324 (session 25c6863d turn 5)：rewriter 凭 dark_s01 字面
  // 主动补 <background scene="dark_s01" />，违反"不补剧情"约束。加显式硬约束。
  it('rewriter 硬约束含"不补视觉子标签"（含 dark_s01 反例）', () => {
    const sys = buildRewriteSystemPrompt();
    expect(sys).toContain('不补视觉子标签');
    // 必须明确列出三种视觉子标签
    expect(sys).toContain('<background/>');
    expect(sys).toContain('<sprite/>');
    expect(sys).toContain('<stage/>');
    // 包含 trace f6a68324 那种"凭 id 名称猜"的反例 + 正例
    expect(sys).toContain('dark_s01');
    expect(sys).toMatch(/继承.*延续|延续.*上一单元/);
  });
});

// 改进 C1（2026-04-26）：parser degrade 段加软提醒 + 判断要点
describe('rewriter user message — parser degrade 软提醒', () => {
  function makeUserMsg(degrades: Array<{ code: string; detail: string }> = []): string {
    return buildRewriteUserMessage({
      rawText: 'raw 输出',
      parserView: {
        sentences: [],
        scratchCount: 0,
        // ParserView.degrades 期望是 DegradeEvent[]（含 code + detail）
        degrades: degrades as unknown as RewriteInput['parserView']['degrades'],
        looksBroken: degrades.length > 0,
      },
      manifest: { characterIds: [], backgroundIds: [], moodsByCharacter: {} },
      turn: 1,
    });
  }

  it('包含"事实信息**不是修复指令**"软提醒', () => {
    const msg = makeUserMsg();
    expect(msg).toContain('事实信息');
    expect(msg).toContain('不是修复指令');
  });

  it('包含 3 步判断框架（定位 / 看协议规则 / 决定修复）', () => {
    const msg = makeUserMsg();
    expect(msg).toContain('定位');
    expect(msg).toContain('协议规则');
    expect(msg).toContain('决定是否修复');
  });

  it('为最容易误判的 3 类 degrade 给判断要点', () => {
    const msg = makeUserMsg();
    // bare-text-outside-container 区分元描述 vs 叙事
    expect(msg).toContain('bare-text-outside-container');
    expect(msg).toContain('元描述');
    expect(msg).toContain('叙事内容');
    // dialogue-adhoc-speaker 指向三档分级
    expect(msg).toContain('dialogue-adhoc-speaker');
    expect(msg).toContain('三档分级');
    // container-truncated 禁止补内容
    expect(msg).toContain('container-truncated');
    expect(msg).toContain('不要试图补完');
  });

  it('degrade list 仍按 fact-only 格式呈现（code + detail，无修复方向）', () => {
    const msg = makeUserMsg([
      { code: 'bare-text-outside-container', detail: '你穿过自由市场...' },
      { code: 'dialogue-adhoc-speaker', detail: '__npc__陌生男声' },
    ]);
    // 仍然是 list 格式，不被改成"必修清单"
    expect(msg).toContain('bare-text-outside-container: 你穿过自由市场...');
    expect(msg).toContain('dialogue-adhoc-speaker: __npc__陌生男声');
    // 没有强制修复指令文字（避免误判）
    expect(msg).not.toContain('必须修复');
    expect(msg).not.toContain('必修');
  });

  // 修复 trace f6a68324：manifest 段以前给 rewriter background id 列表
  // （从 buildEngineRulesWhitelistV2 reuse），rewriter 看到诱导幻觉。
  // 改成只给 character id。
  it('user message manifest 段只给 character id，不含 background / mood', () => {
    const msg = buildRewriteUserMessage({
      rawText: '<narration>x</narration>',
      parserView: { sentences: [], scratchCount: 0, degrades: [], looksBroken: false },
      manifest: {
        characterIds: ['sakuya', 'aonkei'],
        backgroundIds: ['classroom_evening', 'dark_s01', 'dark_s02'],
        moodsByCharacter: {
          sakuya: ['smiling', 'thinking'],
          aonkei: ['neutral'],
        },
      },
      turn: 1,
    });
    // character id **必须**有
    expect(msg).toContain('sakuya');
    expect(msg).toContain('aonkei');
    // background id **必须没有**（防止 rewriter 凭白名单 id 字面猜）
    expect(msg).not.toContain('classroom_evening');
    expect(msg).not.toContain('dark_s01');
    expect(msg).not.toContain('dark_s02');
    // mood id 也不该出现
    expect(msg).not.toContain('smiling');
    expect(msg).not.toContain('thinking');
    expect(msg).not.toContain('neutral');
  });

  it('user message manifest 段：character 白名单为空时显示占位', () => {
    const msg = buildRewriteUserMessage({
      rawText: '<narration>x</narration>',
      parserView: { sentences: [], scratchCount: 0, degrades: [], looksBroken: false },
      manifest: { characterIds: [], backgroundIds: [], moodsByCharacter: {} },
      turn: 1,
    });
    expect(msg).toContain('剧本未定义任何角色');
  });
});
