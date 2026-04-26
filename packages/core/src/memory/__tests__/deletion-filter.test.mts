/**
 * MemoryDeletionFilter behavior（ANN.1）
 *
 * 覆盖各 adapter 的 retrieve filter + retrieval-logger wrapper。Reader 走
 * undefined 路径（adapter 行为契约：undefined reader → 不读历史，pinned + 空 entries）。
 * 完整 reader 路径已被 adapter 自身的现有测试覆盖。
 */

import { describe, it, expect, mock } from 'bun:test';
import { LegacyMemory } from '#internal/memory/legacy/manager';
import { LLMSummarizerMemory } from '#internal/memory/llm-summarizer/manager';
import type {
  Memory,
  MemoryConfig,
  MemoryDeletionFilter,
  MemoryEntry,
  MemoryRetrieval,
} from '#internal/memory/types';
import {
  wrapMemoryWithRetrievalLogger,
  type RetrievalLogger,
} from '#internal/memory/retrieval-logger';

const baseConfig: MemoryConfig = {
  contextBudget: 100000,
  compressionThreshold: 50000,
  recencyWindow: 5,
  provider: 'legacy',
};

const noopCompress = async (entries: MemoryEntry[]) =>
  entries.map((e) => `[${e.role}] ${e.content.slice(0, 100)}`).join('\n');

function fixedFilter(deletedIds: string[]): MemoryDeletionFilter {
  return {
    async listDeleted() {
      return new Set(deletedIds);
    },
  };
}

// ============================================================================
// LegacyMemory + filter
// ============================================================================

describe('LegacyMemory + deletionFilter', () => {
  it('filters pinned entries by id from summary', async () => {
    // 不传 reader，retrieve 只看 pinned
    const mem = new LegacyMemory(baseConfig, noopCompress, undefined, fixedFilter([]));
    const a = await mem.pin('Alice 是侦探');
    const b = await mem.pin('Bob 是嫌疑人');
    const c = await mem.pin('凶器是花瓶');
    void a; void c;

    const before = await mem.retrieve('');
    expect(before.summary).toContain('Alice');
    expect(before.summary).toContain('Bob');
    expect(before.summary).toContain('花瓶');

    // 重建 adapter 加 filter 把 b 标删，restore snapshot
    const snap = await mem.snapshot();
    const filteredMem = new LegacyMemory(baseConfig, noopCompress, undefined, fixedFilter([b.id]));
    await filteredMem.restore(snap);
    const after = await filteredMem.retrieve('');
    expect(after.summary).toContain('Alice');
    expect(after.summary).not.toContain('Bob');
    expect(after.summary).toContain('花瓶');
  });

  it('falls back to no filter when listDeleted throws', async () => {
    const failingFilter: MemoryDeletionFilter = {
      async listDeleted() {
        throw new Error('DB connection lost');
      },
    };
    const mem = new LegacyMemory(baseConfig, noopCompress, undefined, failingFilter);
    await mem.pin('test');
    // retrieve 不应抛错；返回完整 pinned 当作没 filter
    const r = await mem.retrieve('');
    expect(r.summary).toContain('test');
  });

  it('no-op when deletionFilter is undefined', async () => {
    const mem = new LegacyMemory(baseConfig, noopCompress, undefined);
    await mem.pin('test');
    const r = await mem.retrieve('');
    expect(r.summary).toContain('test');
  });
});

// ============================================================================
// LLMSummarizerMemory + filter (parity with legacy)
// ============================================================================

describe('LLMSummarizerMemory + deletionFilter', () => {
  const stubLlm = { generate: async () => ({ text: '', usage: undefined } as never) };

  it('filters pinned entries by id from summary', async () => {
    const mem = new LLMSummarizerMemory(baseConfig, stubLlm as never, undefined);
    await mem.pin('Alice');
    await mem.pin('Bob');
    const snap = await mem.snapshot();
    const ids = (snap.pinned as Array<{ id: string }>).map((p) => p.id);

    const filteredMem = new LLMSummarizerMemory(
      baseConfig,
      stubLlm as never,
      undefined,
      fixedFilter([ids[1]!]), // 删 Bob
    );
    await filteredMem.restore(snap);
    const r = await filteredMem.retrieve('');
    expect(r.summary).toContain('Alice');
    expect(r.summary).not.toContain('Bob');
  });
});

// ============================================================================
// wrapMemoryWithRetrievalLogger
// ============================================================================

describe('wrapMemoryWithRetrievalLogger', () => {
  function fakeMemory(retrieveResult: MemoryRetrieval): Memory {
    return {
      kind: 'fake',
      async retrieve() { return retrieveResult; },
      async appendTurn() { return {} as never; },
      async pin() { return {} as never; },
      async getRecentAsMessages() { return { messages: [], tokensUsed: 0 }; },
      async maybeCompact() {},
      async snapshot() { return { kind: 'fake' }; },
      async restore() {},
      async reset() {},
    };
  }

  it('passes through retrieve result and invokes logger with context', async () => {
    const logger = mock<RetrievalLogger>(() => {});
    const inner = fakeMemory({ summary: 'hello', entries: [] });
    const wrapped = wrapMemoryWithRetrievalLogger(inner, {
      logger,
      getTurn: () => 5,
      getBatchId: () => 'batch-abc',
    });

    const result = await wrapped.retrieve('what happened');
    expect(result.summary).toBe('hello');

    // logger is fire-and-forget; flush microtasks
    await new Promise((r) => setImmediate(r));
    expect(logger).toHaveBeenCalledTimes(1);
    const callArgs = logger.mock.calls[0]!;
    expect(callArgs[0]).toEqual({
      source: 'context-assembly',
      query: 'what happened',
      turn: 5,
      batchId: 'batch-abc',
    });
    expect(callArgs[1].summary).toBe('hello');
  });

  it('does not throw when logger rejects', async () => {
    const inner = fakeMemory({ summary: 's', entries: [] });
    const wrapped = wrapMemoryWithRetrievalLogger(inner, {
      logger: async () => {
        throw new Error('logger boom');
      },
      getTurn: () => 1,
      getBatchId: () => null,
    });
    const r = await wrapped.retrieve('q');
    expect(r.summary).toBe('s');
    await new Promise((r) => setImmediate(r));
  });

  it('passes through other Memory methods unchanged', async () => {
    const inner = fakeMemory({ summary: '', entries: [] });
    const appendSpy = mock(() => Promise.resolve({} as never));
    const pinSpy = mock(() => Promise.resolve({} as never));
    inner.appendTurn = appendSpy;
    inner.pin = pinSpy;

    const wrapped = wrapMemoryWithRetrievalLogger(inner, {
      logger: () => {},
      getTurn: () => 1,
      getBatchId: () => null,
    });

    await wrapped.appendTurn({ turn: 1, role: 'generate', content: 'x', tokenCount: 1 });
    await wrapped.pin('y');
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(pinSpy).toHaveBeenCalledTimes(1);
  });
});
