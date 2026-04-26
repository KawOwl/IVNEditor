/**
 * ParallelMemory · fan-out 写、retrieve 优先级 fallback
 *
 * 重点覆盖：
 *   - 写：所有 child fan-out；一边失败另一边照样进
 *   - 读：第一个 child 成功 → 用它；第一个 meta.error 或 throw → fallback 下一个
 *   - 读：全失败 → meta.source='all-failed'，不抛
 *   - getRecentAsMessages 走 coreEventReader（不走 child）
 *   - snapshot/restore：按 name 分发；missing/extra child name 安全跳过
 *   - factory：'parallel' 默认 children=['memorax','mem0']；自定义 children；未知 name 报错
 */

import { describe, it, expect, mock } from 'bun:test';
import { ParallelMemory, type ParallelMemoryChild } from '#internal/memory/parallel/adapter';
import { createMemory } from '#internal/memory/factory';
import type { Memory, MemoryRetrieval, MemorySnapshot } from '#internal/memory/types';
import type { CoreEventHistoryReader } from '#internal/game-session/core-event-history';
import type { MemoryConfig, MemoryEntry } from '@ivn/core/types';

// ============================================================================
// Fake Memory adapter — scriptable behaviors
// ============================================================================

interface FakeBehavior {
  retrieveResult?: MemoryRetrieval;
  retrieveThrows?: Error;
  appendThrows?: Error;
  pinThrows?: Error;
  resetThrows?: Error;
  maybeCompactThrows?: Error;
  snapshotKind?: string;
}

interface FakeCalls {
  appendTurn: number;
  pin: number;
  retrieve: Array<{ query: string }>;
  maybeCompact: number;
  reset: number;
  snapshot: number;
  restore: MemorySnapshot[];
}

function makeFake(name: string, behavior: FakeBehavior = {}): { memory: Memory; calls: FakeCalls } {
  const calls: FakeCalls = {
    appendTurn: 0, pin: 0, retrieve: [], maybeCompact: 0, reset: 0, snapshot: 0, restore: [],
  };
  const kind = behavior.snapshotKind ?? `${name}-fake-v1`;
  const memory: Memory = {
    kind: name,
    async appendTurn(p) {
      calls.appendTurn++;
      if (behavior.appendThrows) throw behavior.appendThrows;
      return {
        id: `mem-${name}-${calls.appendTurn}`,
        turn: p.turn, role: p.role, content: p.content, tokenCount: p.tokenCount,
        timestamp: Date.now(), tags: p.tags, pinned: false,
      };
    },
    async pin(content, tags) {
      calls.pin++;
      if (behavior.pinThrows) throw behavior.pinThrows;
      return {
        id: `mem-${name}-pin-${calls.pin}`,
        turn: -1, role: 'system', content, tokenCount: 0, timestamp: Date.now(), tags, pinned: true,
      };
    },
    async retrieve(query) {
      calls.retrieve.push({ query });
      if (behavior.retrieveThrows) throw behavior.retrieveThrows;
      return behavior.retrieveResult ?? { summary: '', entries: [], meta: {} };
    },
    async getRecentAsMessages() { return { messages: [], tokensUsed: 0 }; },
    async maybeCompact() {
      calls.maybeCompact++;
      if (behavior.maybeCompactThrows) throw behavior.maybeCompactThrows;
    },
    async snapshot() {
      calls.snapshot++;
      return { kind, label: name };
    },
    async restore(snap) {
      calls.restore.push(snap);
      if (snap.kind !== kind) throw new Error(`fake ${name} cannot restore from ${String(snap.kind)}`);
    },
    async reset() {
      calls.reset++;
      if (behavior.resetThrows) throw behavior.resetThrows;
    },
  };
  return { memory, calls };
}

const baseConfig: MemoryConfig = {
  contextBudget: 100000,
  compressionThreshold: 100000,
  recencyWindow: 4,
};

const baseScope = { playthroughId: 'pt-1', userId: 'u-1' };

const silenceConsole = () => {
  const errSpy = mock(() => {});
  const warnSpy = mock(() => {});
  const origErr = console.error;
  const origWarn = console.warn;
  console.error = errSpy as unknown as typeof console.error;
  console.warn = warnSpy as unknown as typeof console.warn;
  return {
    errSpy, warnSpy,
    restore: () => { console.error = origErr; console.warn = origWarn; },
  };
};

// ============================================================================
// Tests
// ============================================================================

describe('ParallelMemory · write fan-out', () => {
  it('appendTurn calls every child', async () => {
    const a = makeFake('a');
    const b = makeFake('b');
    const memory = new ParallelMemory(baseConfig, [
      { name: 'a', memory: a.memory },
      { name: 'b', memory: b.memory },
    ]);

    await memory.appendTurn({ turn: 1, role: 'generate', content: 'x', tokenCount: 1 });

    expect(a.calls.appendTurn).toBe(1);
    expect(b.calls.appendTurn).toBe(1);
  });

  it('appendTurn: one child throws, the other succeeds, no throw at parallel layer', async () => {
    const a = makeFake('a', { appendThrows: new Error('a is down') });
    const b = makeFake('b');
    const memory = new ParallelMemory(baseConfig, [
      { name: 'a', memory: a.memory },
      { name: 'b', memory: b.memory },
    ]);
    const c = silenceConsole();

    const entry = await memory.appendTurn({ turn: 1, role: 'generate', content: 'x', tokenCount: 1 });

    expect(a.calls.appendTurn).toBe(1);
    expect(b.calls.appendTurn).toBe(1);
    expect(entry.content).toBe('x'); // returned from b
    expect(c.errSpy).toHaveBeenCalled();
    c.restore();
  });

  it('pin / maybeCompact / reset all fan-out and log rejections', async () => {
    const a = makeFake('a', {
      pinThrows: new Error('p'), resetThrows: new Error('r'), maybeCompactThrows: new Error('c'),
    });
    const b = makeFake('b');
    const memory = new ParallelMemory(baseConfig, [
      { name: 'a', memory: a.memory },
      { name: 'b', memory: b.memory },
    ]);
    const c = silenceConsole();

    await memory.pin('important', []);
    await memory.maybeCompact();
    await memory.reset();

    expect(a.calls.pin).toBe(1); expect(b.calls.pin).toBe(1);
    expect(a.calls.maybeCompact).toBe(1); expect(b.calls.maybeCompact).toBe(1);
    expect(a.calls.reset).toBe(1); expect(b.calls.reset).toBe(1);
    expect(c.errSpy).toHaveBeenCalledTimes(3);
    c.restore();
  });
});

describe('ParallelMemory · retrieve priority fallback', () => {
  const okResult: MemoryRetrieval = {
    summary: '[Relevant Memories]\n- A',
    entries: [],
    meta: { topK: 10, returned: 1 },
  };
  const errResult: MemoryRetrieval = { summary: '', entries: [], meta: { error: 'memorax exploded' } };

  it('first child succeeds → uses its result, marks meta.source', async () => {
    const primary = makeFake('memorax', { retrieveResult: okResult });
    const fallback = makeFake('mem0');
    const memory = new ParallelMemory(baseConfig, [
      { name: 'memorax', memory: primary.memory },
      { name: 'mem0', memory: fallback.memory },
    ]);

    const result = await memory.retrieve('q');

    expect(primary.calls.retrieve).toHaveLength(1);
    expect(fallback.calls.retrieve).toHaveLength(0); // never asked
    expect(result.summary).toBe(okResult.summary);
    expect(result.meta?.source).toBe('memorax');
    expect(result.meta?.attempted).toBeUndefined();
  });

  it('first child returns meta.error → falls back to second; result tagged source=mem0 + attempted', async () => {
    const primary = makeFake('memorax', { retrieveResult: errResult });
    const fallback = makeFake('mem0', { retrieveResult: okResult });
    const memory = new ParallelMemory(baseConfig, [
      { name: 'memorax', memory: primary.memory },
      { name: 'mem0', memory: fallback.memory },
    ]);
    const c = silenceConsole();

    const result = await memory.retrieve('q');

    expect(primary.calls.retrieve).toHaveLength(1);
    expect(fallback.calls.retrieve).toHaveLength(1);
    expect(result.summary).toBe(okResult.summary);
    expect(result.meta?.source).toBe('mem0');
    expect(Array.isArray(result.meta?.attempted)).toBe(true);
    expect((result.meta?.attempted as Array<{ name: string }>)[0]!.name).toBe('memorax');
    expect(c.warnSpy).toHaveBeenCalled();
    c.restore();
  });

  it('first child throws → falls back to second', async () => {
    const primary = makeFake('memorax', { retrieveThrows: new Error('boom') });
    const fallback = makeFake('mem0', { retrieveResult: okResult });
    const memory = new ParallelMemory(baseConfig, [
      { name: 'memorax', memory: primary.memory },
      { name: 'mem0', memory: fallback.memory },
    ]);
    const c = silenceConsole();

    const result = await memory.retrieve('q');

    expect(primary.calls.retrieve).toHaveLength(1);
    expect(fallback.calls.retrieve).toHaveLength(1);
    expect(result.summary).toBe(okResult.summary);
    expect(result.meta?.source).toBe('mem0');
    c.restore();
  });

  it('all children fail → empty result + meta.source=all-failed; no throw', async () => {
    const primary = makeFake('memorax', { retrieveResult: errResult });
    const fallback = makeFake('mem0', { retrieveThrows: new Error('mem0 timeout') });
    const memory = new ParallelMemory(baseConfig, [
      { name: 'memorax', memory: primary.memory },
      { name: 'mem0', memory: fallback.memory },
    ]);
    const c = silenceConsole();

    const result = await memory.retrieve('q');

    expect(result.summary).toBe('');
    expect(result.entries).toEqual([]);
    expect(result.meta?.source).toBe('all-failed');
    expect((result.meta?.attempted as Array<{ name: string }>).map((a) => a.name)).toEqual([
      'memorax',
      'mem0',
    ]);
    c.restore();
  });

  it('first child returns empty (no error) → uses it (empty is legitimate, not failure)', async () => {
    const primary = makeFake('memorax', {
      retrieveResult: { summary: '', entries: [], meta: { topK: 10, returned: 0 } },
    });
    const fallback = makeFake('mem0', { retrieveResult: { summary: 'should-not-appear', entries: [] } });
    const memory = new ParallelMemory(baseConfig, [
      { name: 'memorax', memory: primary.memory },
      { name: 'mem0', memory: fallback.memory },
    ]);

    const result = await memory.retrieve('q');

    expect(primary.calls.retrieve).toHaveLength(1);
    expect(fallback.calls.retrieve).toHaveLength(0); // empty != error
    expect(result.summary).toBe('');
    expect(result.meta?.source).toBe('memorax');
  });
});

describe('ParallelMemory · getRecentAsMessages', () => {
  it('uses coreEventReader directly, not children', async () => {
    const fake = makeFake('memorax');
    // 不传 reader → 应该返回空
    const memory = new ParallelMemory(baseConfig, [{ name: 'memorax', memory: fake.memory }]);

    const result = await memory.getRecentAsMessages({ budget: 1000 });

    expect(result.messages).toEqual([]);
    expect(result.tokensUsed).toBe(0);
  });

  it('uses provided reader to project messages', async () => {
    const fake = makeFake('memorax');
    const reader: CoreEventHistoryReader = {
      readRecent: async () => [],
      readRange: async () => [],
    };
    const memory = new ParallelMemory(
      baseConfig,
      [{ name: 'memorax', memory: fake.memory }],
      reader,
    );

    const result = await memory.getRecentAsMessages({ budget: 1000 });

    expect(result.messages).toEqual([]);
    expect(result.tokensUsed).toBe(0);
  });
});

describe('ParallelMemory · snapshot / restore', () => {
  it('snapshot kind is parallel-v1, children carry name + child snapshot', async () => {
    const a = makeFake('a');
    const b = makeFake('b');
    const memory = new ParallelMemory(baseConfig, [
      { name: 'memorax', memory: a.memory },
      { name: 'mem0', memory: b.memory },
    ]);

    const snap = await memory.snapshot();

    expect(snap.kind).toBe('parallel-v1');
    const children = snap.children as Array<{ name: string; snapshot: MemorySnapshot }>;
    expect(children).toHaveLength(2);
    expect(children[0]!.name).toBe('memorax');
    expect(children[1]!.name).toBe('mem0');
  });

  it('restore distributes by name; ignores entries for missing children', async () => {
    const a = makeFake('memorax');
    const b = makeFake('mem0');
    const memory = new ParallelMemory(baseConfig, [
      { name: 'memorax', memory: a.memory },
      { name: 'mem0', memory: b.memory },
    ]);
    const memoraxSnap = { kind: 'memorax-fake-v1', label: 'memorax' };
    const mem0Snap = { kind: 'mem0-fake-v1', label: 'mem0' };

    await memory.restore({
      kind: 'parallel-v1',
      children: [
        { name: 'memorax', snapshot: memoraxSnap },
        { name: 'mem0', snapshot: mem0Snap },
        { name: 'gone-provider', snapshot: { kind: 'old-v1' } }, // missing child — skip
      ],
    });

    expect(a.calls.restore).toHaveLength(1);
    expect(b.calls.restore).toHaveLength(1);
    expect(a.calls.restore[0]).toEqual(memoraxSnap);
    expect(b.calls.restore[0]).toEqual(mem0Snap);
  });

  it('restore rejects non-parallel snapshot kind', async () => {
    const a = makeFake('memorax');
    const memory = new ParallelMemory(baseConfig, [{ name: 'memorax', memory: a.memory }]);

    expect(memory.restore({ kind: 'mem0-v1', recentEntries: [] })).rejects.toThrow(
      /ParallelMemory cannot restore/,
    );
  });
});

describe('factory · provider:parallel', () => {
  const fullCfg = {
    scope: baseScope,
    memoraxConfig: { baseUrl: 'http://memorax.test', apiKey: 'sk_test', appId: 'ivn-editor' },
    mem0ApiKey: 'm0-test',
  };

  it('default children = [memorax, mem0] (memorax-primary)', async () => {
    const memory = await createMemory({
      ...fullCfg,
      config: { ...baseConfig, provider: 'parallel' },
    });
    expect(memory.kind).toBe('parallel');
  });

  it('custom children list', async () => {
    const memory = await createMemory({
      ...fullCfg,
      config: { ...baseConfig, provider: 'parallel', providerOptions: { children: ['mem0'] } },
    });
    expect(memory.kind).toBe('parallel');
  });

  it('rejects unknown child name', async () => {
    expect(
      createMemory({
        ...fullCfg,
        config: {
          ...baseConfig, provider: 'parallel',
          providerOptions: { children: ['memorax', 'noop'] },
        },
      }),
    ).rejects.toThrow(/unknown child "noop"/);
  });

  it('rejects empty children array', async () => {
    expect(
      createMemory({
        ...fullCfg,
        config: { ...baseConfig, provider: 'parallel', providerOptions: { children: [] } },
      }),
    ).rejects.toThrow(/at least one child/);
  });

  it('child build error propagates (e.g. memorax in list but memoraxConfig missing)', async () => {
    expect(
      createMemory({
        scope: baseScope,
        config: { ...baseConfig, provider: 'parallel' },
        // 没传 memoraxConfig 和 mem0ApiKey
      }),
    ).rejects.toThrow(/memoraxConfig|mem0ApiKey/);
  });
});

// suppress unused warning for MemoryEntry import
type _Unused = MemoryEntry;
