/**
 * 章节切换后 prompt 组装正确性验证
 *
 * 验证 assembleContext 按 state.chapter 值正确过滤 segments：
 *   - chapter=1 时 ch1 段（injectionRule: `chapter === 1`）注入，ch2 段不注入
 *   - chapter=2 时相反
 *   - 无 injectionRule 的全局段（system-rules / world-brief）始终注入
 *
 * 这是 .claude/plans/architecture-alignment.md 里"章节切换驱动 prompt 重组"
 * 的 canonical 回归测试 —— 实测剧本（seed-test-e2e）证明 E2E 通，这里锁住
 * 编译期的过滤行为不被后续 refactor 破坏。
 */

import { describe, it, expect } from 'bun:test';
import { assembleContext } from '../context-assembler';
import { StateStore } from '../state-store';
import type { PromptSegment } from '../types';
import type { Memory } from '../memory/types';

function makeSeg(partial: Partial<PromptSegment> & Pick<PromptSegment, 'id' | 'content'>): PromptSegment {
  return {
    id: partial.id,
    label: partial.id,
    type: 'content',
    role: 'context',
    priority: 5,
    sourceDoc: partial.id,
    contentHash: '',
    tokenCount: Math.ceil(partial.content.length / 2),
    ...partial,
  };
}

function mockMemory(): Memory {
  return {
    kind: 'mock',
    async appendTurn() { return {} as any; },
    async pin() { return {} as any; },
    async retrieve() { return { summary: '' }; },
    async getRecentAsMessages() { return { messages: [], tokensUsed: 0 }; },
    async maybeCompact() {},
    async snapshot() { return { kind: 'mock' }; },
    async restore() {},
    async reset() {},
  } as Memory;
}

function segments(): PromptSegment[] {
  return [
    makeSeg({
      id: 'system-rules',
      content: 'GLOBAL_RULES: you are a GM',
      role: 'system',
      priority: 1,
    }),
    makeSeg({
      id: 'world-brief',
      content: 'WORLD_BRIEF: library universe',
      role: 'context',
      priority: 2,
    }),
    // ch1 独占段
    makeSeg({
      id: 'ch1-mission',
      content: 'CH1_MISSION: hall scene with Jenkins',
      injectionRule: { description: '仅 ch1', condition: 'chapter === 1' },
    }),
    makeSeg({
      id: 'jenkins-character',
      content: 'JENKINS_CHARACTER: librarian',
      injectionRule: { description: '仅 ch1', condition: 'chapter === 1' },
    }),
    // ch2 独占段
    makeSeg({
      id: 'ch2-mission',
      content: 'CH2_MISSION: deep_stacks with Luna',
      injectionRule: { description: '仅 ch2', condition: 'chapter === 2' },
    }),
    makeSeg({
      id: 'luna-character',
      content: 'LUNA_CHARACTER: mysterious reader',
      injectionRule: { description: '仅 ch2', condition: 'chapter === 2' },
    }),
  ];
}

describe('章节切换 · prompt 组装', () => {
  it('chapter=1：ch1 段注入、ch2 段被过滤掉，全局段保留', async () => {
    const state = new StateStore({
      variables: [
        { name: 'chapter', type: 'number', initial: 1 },
      ],
    });
    // chapter 已初始化为 1
    const ctx = await assembleContext({
      segments: segments(),
      stateStore: state,
      memory: mockMemory(),
      tokenBudget: 100000,
      currentQuery: '',
    });

    // 全局段存在
    expect(ctx.systemPrompt).toContain('GLOBAL_RULES');
    expect(ctx.systemPrompt).toContain('WORLD_BRIEF');
    // ch1 段存在
    expect(ctx.systemPrompt).toContain('CH1_MISSION');
    expect(ctx.systemPrompt).toContain('JENKINS_CHARACTER');
    // ch2 段不存在
    expect(ctx.systemPrompt).not.toContain('CH2_MISSION');
    expect(ctx.systemPrompt).not.toContain('LUNA_CHARACTER');
  });

  it('chapter=2：ch2 段注入、ch1 段被过滤掉，全局段保留', async () => {
    const state = new StateStore({
      variables: [
        { name: 'chapter', type: 'number', initial: 1 },
      ],
    });
    // LLM 调 update_state({chapter:2}) 之后
    state.update({ chapter: 2 }, 'llm');

    const ctx = await assembleContext({
      segments: segments(),
      stateStore: state,
      memory: mockMemory(),
      tokenBudget: 100000,
      currentQuery: '',
    });

    // 全局段存在
    expect(ctx.systemPrompt).toContain('GLOBAL_RULES');
    expect(ctx.systemPrompt).toContain('WORLD_BRIEF');
    // ch1 段消失
    expect(ctx.systemPrompt).not.toContain('CH1_MISSION');
    expect(ctx.systemPrompt).not.toContain('JENKINS_CHARACTER');
    // ch2 段出现
    expect(ctx.systemPrompt).toContain('CH2_MISSION');
    expect(ctx.systemPrompt).toContain('LUNA_CHARACTER');
  });

  it('chapter=3（未定义章节）：所有章节段都被过滤，只剩全局段', async () => {
    const state = new StateStore({
      variables: [
        { name: 'chapter', type: 'number', initial: 1 },
      ],
    });
    state.update({ chapter: 3 }, 'llm');

    const ctx = await assembleContext({
      segments: segments(),
      stateStore: state,
      memory: mockMemory(),
      tokenBudget: 100000,
      currentQuery: '',
    });

    expect(ctx.systemPrompt).toContain('GLOBAL_RULES');
    expect(ctx.systemPrompt).toContain('WORLD_BRIEF');
    expect(ctx.systemPrompt).not.toContain('CH1_MISSION');
    expect(ctx.systemPrompt).not.toContain('CH2_MISSION');
  });

  it('非法/缺失 chapter：condition 求值失败 → segment 不注入', async () => {
    const state = new StateStore({
      variables: [],
    });
    // state 里没有 chapter 变量；injectionRule "chapter === 1" 会因未定义
    // 变量而抛错，evaluateCondition 降级 false，所有 chapter 相关段都过滤掉。
    const ctx = await assembleContext({
      segments: segments(),
      stateStore: state,
      memory: mockMemory(),
      tokenBudget: 100000,
      currentQuery: '',
    });

    expect(ctx.systemPrompt).toContain('GLOBAL_RULES');
    expect(ctx.systemPrompt).not.toContain('CH1_MISSION');
    expect(ctx.systemPrompt).not.toContain('CH2_MISSION');
  });
});
