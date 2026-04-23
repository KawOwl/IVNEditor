/**
 * tool-executor · turn-bounded 模式验证
 *
 * 见 .claude/plans/turn-bounded-generate.md
 * 方案 B 核心：signal_input_needed.execute 改 record-only，不挂起，立即返回
 * success:true。ctx.recordPendingSignal 回调把 {hint, choices} 记下给 coreLoop
 * 在 generate 返回后读。
 */

import { describe, it, expect } from 'bun:test';
import { createTools } from '../tool-executor';
import { StateStore } from '../state-store';
import type { Memory } from '../memory/types';

// ============================================================================
// Mock Memory（不做任何真事，signal_input_needed 不会用到）
// ============================================================================

function makeMockMemory(): Memory {
  return {
    kind: 'mock',
    async appendTurn() {},
    async pin() { return { role: 'system', content: '', turn: 0, tokenCount: 0 }; },
    async retrieve() { return { summary: '' }; },
    async getRecentAsMessages() { return { messages: [], tokensUsed: 0 }; },
    async maybeCompact() {},
    async snapshot() { return { kind: 'mock' }; },
    async restore() {},
  } as Memory;
}

// ============================================================================
// Tests
// ============================================================================

describe('signal_input_needed · turn-bounded 模式', () => {
  it('execute 同步返回 success:true（不挂起）', async () => {
    const recorded: Array<{ hint?: string; choices?: string[] }> = [];
    const tools = createTools({
      stateStore: new StateStore({ variables: [] }),
      memory: makeMockMemory(),
      segments: [],
      recordPendingSignal: (options) => {
        recorded.push(options);
      },
    });
    const start = Date.now();
    const result = await tools['signal_input_needed']!.execute({
      prompt_hint: '你想做什么？',
      choices: ['前进', '后退'],
    });
    const elapsed = Date.now() - start;

    expect(result).toEqual({ success: true });
    expect(elapsed).toBeLessThan(100); // sub-100ms 足够证明"不挂起"
    expect(recorded).toEqual([
      { hint: '你想做什么？', choices: ['前进', '后退'] },
    ]);
  });

  it('recordPendingSignal 未注册 → 返回 error（兼容 handler 缺失场景）', async () => {
    const tools = createTools({
      stateStore: new StateStore({ variables: [] }),
      memory: makeMockMemory(),
      segments: [],
      // 不传 recordPendingSignal
    });
    const result = await tools['signal_input_needed']!.execute({
      prompt_hint: 'Q',
      choices: ['A'],
    }) as { success: boolean; error?: string };
    expect(result.success).toBe(false);
    expect(result.error).toContain('signal handler');
  });

  it('recordPendingSignal 是 async → execute 等它完成再返回', async () => {
    let resolved = false;
    const tools = createTools({
      stateStore: new StateStore({ variables: [] }),
      memory: makeMockMemory(),
      segments: [],
      recordPendingSignal: async (_options) => {
        // 模拟异步 persist
        await new Promise((r) => setTimeout(r, 10));
        resolved = true;
      },
    });
    const result = await tools['signal_input_needed']!.execute({
      prompt_hint: 'Q',
      choices: ['A'],
    });
    expect(resolved).toBe(true); // execute 确保在 resolve 之前 record 完成
    expect(result).toEqual({ success: true });
  });

  it('LLM 传空 choices 也会调 recordPendingSignal（未来 freetext signal）', async () => {
    const recorded: Array<{ hint?: string; choices?: string[] }> = [];
    const tools = createTools({
      stateStore: new StateStore({ variables: [] }),
      memory: makeMockMemory(),
      segments: [],
      recordPendingSignal: (options) => {
        recorded.push(options);
      },
    });
    const result = await tools['signal_input_needed']!.execute({
      prompt_hint: '随便说',
      choices: [],
    });
    expect(result).toEqual({ success: true });
    expect(recorded[0]).toEqual({ hint: '随便说', choices: [] });
  });
});
