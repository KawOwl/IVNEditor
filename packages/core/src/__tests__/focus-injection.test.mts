/**
 * Focus Injection B2 测试
 *
 * 覆盖 context-assembler 的 focus-aware segment filtering：
 *   1. 无 focus → 所有 segment 注入（老行为）
 *   2. focus.scene 设值：
 *      - 无 focusTags 的 segment → 全部注入
 *      - focusTags.scene 匹配 → 注入
 *      - focusTags.scene 不匹配 → 过滤掉
 *   3. _engine_scene_context section 生成条件
 *      - focus.scene 有值 → 始终输出 focus 头
 *      - 有 ranked segment → 附"Most relevant segments"列表
 *      - 无 ranked → 只有 focus 头，不附列表
 *   4. injectionRule 和 focus 过滤正交（injectionRule=false 的 segment 无论 focus 都过滤）
 *   5. 段内容用 `--- [label] ---` header 包裹（A1 行为保留）
 */

import { describe, it, expect } from 'bun:test';
import { assembleContext, VIRTUAL_IDS } from '#internal/context-assembler';
import { StateStore } from '#internal/state-store';
import type { PromptSegment } from '#internal/types';
import type { Memory } from '#internal/memory/types';

// ── helpers ─────────────────────────────────────────────────────────────

function seg(
  id: string,
  content: string,
  opts: Partial<PromptSegment> = {},
): PromptSegment {
  return {
    id,
    label: opts.label ?? id,
    content,
    contentHash: '',
    type: 'content',
    sourceDoc: 'test',
    role: 'context',
    priority: 5,
    tokenCount: Math.ceil(content.length / 2),
    ...opts,
  };
}

function makeStore(vars: Record<string, unknown>): StateStore {
  const store = new StateStore({
    variables: Object.entries(vars).map(([name, initial]) => ({
      name,
      type: typeof initial === 'number'
        ? 'number'
        : typeof initial === 'boolean'
          ? 'boolean'
          : 'string',
      initial,
      description: '',
    })),
  });
  return store;
}

// legacy-like memory stub that returns empty
function makeMemory(): Memory {
  return {
    kind: 'test',
    appendTurn: async () => ({
      id: 'x',
      turn: 0,
      role: 'generate' as const,
      content: '',
      tokenCount: 0,
      timestamp: 0,
    }),
    pin: async () => ({
      id: 'x',
      turn: 0,
      role: 'system' as const,
      content: '',
      tokenCount: 0,
      timestamp: 0,
    }),
    retrieve: async () => ({ summary: '', pinnedEntries: [], retrievedEntries: [] }),
    getRecentAsMessages: async () => ({ messages: [], tokensUsed: 0 }),
    maybeCompact: async () => {},
    snapshot: async () => ({ kind: 'test-v1' }),
    restore: async () => {},
    reset: async () => {},
  };
}

// ── tests ───────────────────────────────────────────────────────────────

describe('Focus Injection B2 — context-assembler', () => {
  it('无 focus 时所有 segment 都注入', async () => {
    const ctx = await assembleContext({
      segments: [
        seg('global', 'GLOBAL_CONTENT'),
        seg('s_cafe', 'CAFE_CONTENT', { focusTags: { scene: 'cafe' } }),
        seg('s_park', 'PARK_CONTENT', { focusTags: { scene: 'park' } }),
      ],
      stateStore: makeStore({}),
      memory: makeMemory(),
      tokenBudget: 100000,
      currentQuery: '',
    });
    expect(ctx.systemPrompt).toContain('GLOBAL_CONTENT');
    expect(ctx.systemPrompt).toContain('CAFE_CONTENT');
    expect(ctx.systemPrompt).toContain('PARK_CONTENT');
  });

  it('focus.scene 设值时，只注入匹配的 tagged segment + 所有 untagged', async () => {
    const ctx = await assembleContext({
      segments: [
        seg('global', 'GLOBAL_CONTENT'),                                          // untagged → 保留
        seg('s_cafe', 'CAFE_CONTENT', { focusTags: { scene: 'cafe' } }),          // 匹配 → 保留
        seg('s_park', 'PARK_CONTENT', { focusTags: { scene: 'park' } }),          // 不匹配 → 过滤
        seg('s_library', 'LIB_CONTENT', { focusTags: { scene: 'library' } }),     // 不匹配 → 过滤
      ],
      stateStore: makeStore({ current_scene: 'cafe' }),
      memory: makeMemory(),
      tokenBudget: 100000,
      currentQuery: '',
      focus: { scene: 'cafe' },
    });
    expect(ctx.systemPrompt).toContain('GLOBAL_CONTENT');
    expect(ctx.systemPrompt).toContain('CAFE_CONTENT');
    expect(ctx.systemPrompt).not.toContain('PARK_CONTENT');
    expect(ctx.systemPrompt).not.toContain('LIB_CONTENT');
  });

  it('segment 注入加 "--- [label] ---" header（A1 锚点保留）', async () => {
    const ctx = await assembleContext({
      segments: [seg('my_seg', 'BODY', { label: '我的标签' })],
      stateStore: makeStore({}),
      memory: makeMemory(),
      tokenBudget: 100000,
      currentQuery: '',
    });
    expect(ctx.systemPrompt).toContain('--- [我的标签] ---\nBODY');
  });

  it('_engine_scene_context: focus.scene 有值 + 有 ranked → 带 Most relevant segments 列表', async () => {
    const ctx = await assembleContext({
      segments: [
        seg('global', 'G'),
        seg('s_cafe', 'C', { label: 'scene_cafe', focusTags: { scene: 'cafe' } }),
        seg('s_window', 'W', { label: 'scene_window', focusTags: { scene: 'cafe' } }),
      ],
      stateStore: makeStore({ current_scene: 'cafe' }),
      memory: makeMemory(),
      tokenBudget: 100000,
      currentQuery: '',
      focus: { scene: 'cafe' },
    });
    expect(ctx.systemPrompt).toContain('[Current Focus]');
    expect(ctx.systemPrompt).toContain('scene: cafe');
    expect(ctx.systemPrompt).toContain('Most relevant segments:');
    expect(ctx.systemPrompt).toContain(' - scene_cafe');
    expect(ctx.systemPrompt).toContain(' - scene_window');
  });

  it('_engine_scene_context: focus.scene 有值但无匹配 → 只输出 focus 头，不附 Most relevant', async () => {
    const ctx = await assembleContext({
      segments: [
        seg('global', 'G'),
        seg('s_park', 'P', { focusTags: { scene: 'park' } }),   // 不匹配当前 cafe
      ],
      stateStore: makeStore({ current_scene: 'cafe' }),
      memory: makeMemory(),
      tokenBudget: 100000,
      currentQuery: '',
      focus: { scene: 'cafe' },
    });
    expect(ctx.systemPrompt).toContain('[Current Focus]');
    expect(ctx.systemPrompt).toContain('scene: cafe');
    expect(ctx.systemPrompt).not.toContain('Most relevant segments:');
  });

  it('_engine_scene_context: focus={} → section 不生成（向后兼容）', async () => {
    const ctx = await assembleContext({
      segments: [seg('global', 'G')],
      stateStore: makeStore({}),
      memory: makeMemory(),
      tokenBudget: 100000,
      currentQuery: '',
      focus: {},
    });
    expect(ctx.systemPrompt).not.toContain('[Current Focus]');
  });

  it('injectionRule=false 的 segment 不因匹配 focus 而注入（两道过滤都要过）', async () => {
    const ctx = await assembleContext({
      segments: [
        seg('s_cafe', 'CAFE_CONTENT', {
          focusTags: { scene: 'cafe' },
          injectionRule: { description: 'only ch1', condition: 'chapter === 1' },
        }),
      ],
      stateStore: makeStore({ current_scene: 'cafe', chapter: 2 }),
      memory: makeMemory(),
      tokenBudget: 100000,
      currentQuery: '',
      focus: { scene: 'cafe' },
    });
    expect(ctx.systemPrompt).not.toContain('CAFE_CONTENT');
  });

  it('focus 过滤影响 activeSegments → _engine_scene_context 的 ranked 列表只含实际注入的段', async () => {
    const ctx = await assembleContext({
      segments: [
        seg('s_cafe', 'C', {
          label: 'cafe_detail',
          focusTags: { scene: 'cafe' },
          injectionRule: { description: 'ch1 only', condition: 'chapter === 1' },
        }),
      ],
      stateStore: makeStore({ current_scene: 'cafe', chapter: 2 }), // ch1-only segment 被 rule 过滤
      memory: makeMemory(),
      tokenBudget: 100000,
      currentQuery: '',
      focus: { scene: 'cafe' },
    });
    // segment 没注入，所以也不该出现在 Most relevant
    expect(ctx.systemPrompt).not.toContain(' - cafe_detail');
  });

  it('token 节省：有 10 个 scene 段时只注入匹配的 1 个', async () => {
    const scenes = Array.from({ length: 10 }, (_, i) =>
      seg(`s_${i}`, `BODY_${i}_`.repeat(500), {
        focusTags: { scene: `scene_${i}` },
      }),
    );
    // 当前 focus 只匹配 scene_3
    const ctx = await assembleContext({
      segments: scenes,
      stateStore: makeStore({ current_scene: 'scene_3' }),
      memory: makeMemory(),
      tokenBudget: 200000,
      currentQuery: '',
      focus: { scene: 'scene_3' },
    });
    // 只 scene_3 的 body 被注入
    expect(ctx.systemPrompt).toContain('BODY_3_');
    for (let i = 0; i < 10; i++) {
      if (i === 3) continue;
      expect(ctx.systemPrompt).not.toContain(`BODY_${i}_`);
    }
  });
});
