/**
 * MemoraxMemory · Memorax HTTP backend adapter
 *
 * 重点覆盖：
 *   - retrieve 强制按 agent_id (playthroughId) 过滤
 *   - retrieve 失败时**不抛**，返回 meta.error（给 ParallelMemory 做 fallback 信号）
 *   - retrieve 空 query 短路
 *   - appendTurn 走 async_mode=true（fire-and-forget），失败 console.error
 *   - pin 走 async_mode=false（同步等服务端确认）
 *   - snapshot/restore kind 隔离
 *   - factory 通过 provider:'memorax' + memoraxConfig 能 spin
 */

import { describe, it, expect, mock } from 'bun:test';
import { MemoraxMemory } from '#internal/memory/memorax/adapter';
import { MemoraxError } from '#internal/memory/memorax/client';
import type {
  MemoraxClient,
  MemoraxAddRequest,
  MemoraxAddResult,
  MemoraxSearchRequest,
  MemoraxSearchItem,
} from '#internal/memory/memorax/client';
import { entryToMemoraxMessage } from '#internal/memory/memorax/mapping';
import { createMemory } from '#internal/memory/factory';
import type { MemoryConfig, MemoryEntry } from '@ivn/core/types';

// ============================================================================
// Test doubles
// ============================================================================

interface ClientCalls {
  add: MemoraxAddRequest[];
  search: MemoraxSearchRequest[];
}

function makeClient(opts?: {
  addFails?: boolean;
  searchFails?: boolean;
  searchReturns?: MemoraxSearchItem[];
}): { client: MemoraxClient; calls: ClientCalls } {
  const calls: ClientCalls = { add: [], search: [] };
  const client: MemoraxClient = {
    async add(req) {
      calls.add.push(req);
      if (opts?.addFails) {
        throw new MemoraxError(500, 'fake-add-fail', 'simulated add failure');
      }
      const result: MemoraxAddResult = {
        task_id: 'task-' + calls.add.length,
        status: 'completed',
        data: req.messages.map((m, i) => ({
          id: `mem-${calls.add.length}-${i}`,
          event: 'ADD',
          data: { memory: m.content },
        })),
      };
      return result;
    },
    async search(req) {
      calls.search.push(req);
      if (opts?.searchFails) {
        throw new MemoraxError(503, 'fake-search-fail', 'simulated search failure');
      }
      return opts?.searchReturns ?? [];
    },
  };
  return { client, calls };
}

const baseConfig: MemoryConfig = {
  contextBudget: 100000,
  compressionThreshold: 100000,
  recencyWindow: 4,
};

const baseScope = {
  playthroughId: 'pt-abc',
  userId: 'user-xyz',
};

const adapterOpts = (client: MemoraxClient) => ({
  baseUrl: 'http://memorax.test',
  apiKey: 'sk_test',
  appId: 'ivn-editor',
  client,
});

// ============================================================================
// Tests
// ============================================================================

describe('MemoraxMemory · ID mapping & filters', () => {
  it('retrieve passes filters.agent_id.eq = playthroughId (per-playthrough isolation)', async () => {
    const { client, calls } = makeClient({
      searchReturns: [
        {
          id: 'm1',
          memory: 'silver key found in pocket',
          user_id: 'user-xyz',
          agent_id: 'pt-abc',
          app_id: 'ivn-editor',
          session_id: null,
        },
      ],
    });
    const memory = new MemoraxMemory(baseScope, baseConfig, adapterOpts(client));

    await memory.retrieve('what items does the player have');

    expect(calls.search).toHaveLength(1);
    expect(calls.search[0]!.user_id).toBe('user-xyz');
    expect(calls.search[0]!.filters).toEqual({
      and: [{ agent_id: { eq: 'pt-abc' } }],
    });
  });

  it('appendTurn writes user_id=systemUserId, agent_id=playthroughId, app_id=options', async () => {
    const { client, calls } = makeClient();
    const memory = new MemoraxMemory(baseScope, baseConfig, adapterOpts(client));

    await memory.appendTurn({ turn: 3, role: 'generate', content: '一段叙事', tokenCount: 5 });
    // appendTurn 是 fire-and-forget，等一个 tick 让 microtask 跑完
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.add).toHaveLength(1);
    expect(calls.add[0]!.user_id).toBe('user-xyz');
    expect(calls.add[0]!.agent_id).toBe('pt-abc');
    expect(calls.add[0]!.app_id).toBe('ivn-editor');
    expect(calls.add[0]!.async_mode).toBe(true);
    expect(calls.add[0]!.metadata).toMatchObject({ source: 'gameplay', turn: 3, role: 'generate' });
  });
});

describe('MemoraxMemory · retrieve', () => {
  it('empty query → short-circuits to skipped:empty-query, no HTTP call', async () => {
    const { client, calls } = makeClient();
    const memory = new MemoraxMemory(baseScope, baseConfig, adapterOpts(client));

    const result = await memory.retrieve('   ');

    expect(result).toEqual({ summary: '', entries: [], meta: { skipped: 'empty-query' } });
    expect(calls.search).toHaveLength(0);
  });

  it('success with results → "[Relevant Memories]\\n- ..." summary', async () => {
    const { client } = makeClient({
      searchReturns: [
        { id: '1', memory: 'A', user_id: 'u', agent_id: 'pt-abc', app_id: 'ivn-editor', session_id: null },
        { id: '2', memory: 'B', user_id: 'u', agent_id: 'pt-abc', app_id: 'ivn-editor', session_id: null },
      ],
    });
    const memory = new MemoraxMemory(baseScope, baseConfig, adapterOpts(client));

    const result = await memory.retrieve('test');

    expect(result.summary).toBe('[Relevant Memories]\n- A\n- B');
    expect(result.meta).toMatchObject({ topK: 10, returned: 2 });
  });

  it('success with no results → empty summary, meta.returned=0', async () => {
    const { client } = makeClient({ searchReturns: [] });
    const memory = new MemoraxMemory(baseScope, baseConfig, adapterOpts(client));

    const result = await memory.retrieve('nothing here');

    expect(result.summary).toBe('');
    expect(result.meta).toMatchObject({ topK: 10, returned: 0 });
    expect(result.meta?.error).toBeUndefined();
  });

  it('client error → meta.error populated, NO throw (game-session stays robust)', async () => {
    const { client } = makeClient({ searchFails: true });
    const memory = new MemoraxMemory(baseScope, baseConfig, adapterOpts(client));
    // silence console.error for this test
    const errSpy = mock(() => {});
    const original = console.error;
    console.error = errSpy as unknown as typeof console.error;

    const result = await memory.retrieve('q');

    expect(result.summary).toBe('');
    expect(result.entries).toEqual([]);
    expect(typeof result.meta?.error).toBe('string');
    expect((result.meta?.error as string)).toContain('fake-search-fail');
    expect(errSpy).toHaveBeenCalled();

    console.error = original;
  });

  it('respects providerOptions.topK', async () => {
    const { client, calls } = makeClient();
    const memory = new MemoraxMemory(
      baseScope,
      { ...baseConfig, providerOptions: { topK: 25 } },
      adapterOpts(client),
    );

    await memory.retrieve('q');

    expect(calls.search[0]!.top_k).toBe(25);
  });
});

describe('MemoraxMemory · appendTurn / pin', () => {
  it('appendTurn is fire-and-forget — returns entry even when client.add fails', async () => {
    const { client, calls } = makeClient({ addFails: true });
    const memory = new MemoraxMemory(baseScope, baseConfig, adapterOpts(client));
    const errSpy = mock(() => {});
    const original = console.error;
    console.error = errSpy as unknown as typeof console.error;

    const entry = await memory.appendTurn({
      turn: 1,
      role: 'receive',
      content: '玩家：你好',
      tokenCount: 3,
    });

    // entry 立刻可用，HTTP 失败异步 log
    expect(entry.role).toBe('receive');
    expect(entry.content).toBe('玩家：你好');
    expect(entry.pinned).toBe(false);

    // 等 fire-and-forget 的 .catch 跑完
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.add).toHaveLength(1);
    expect(errSpy).toHaveBeenCalled();

    console.error = original;
  });

  it('pin awaits the add (async_mode=false) and tags role=system + metadata.pinned', async () => {
    const { client, calls } = makeClient();
    const memory = new MemoraxMemory(baseScope, baseConfig, adapterOpts(client));

    const entry = await memory.pin('保安咲夜的真名是 sakuya', ['npc-truename']);

    expect(entry.role).toBe('system');
    expect(entry.pinned).toBe(true);
    expect(calls.add).toHaveLength(1);
    expect(calls.add[0]!.async_mode).toBe(false);
    expect(calls.add[0]!.messages[0]!.content).toBe('[PINNED] 保安咲夜的真名是 sakuya');
    expect(calls.add[0]!.metadata).toMatchObject({
      source: 'pin',
      pinned: true,
      tags: ['npc-truename'],
    });
  });

  it('appendTurn caps recentEntries to recencyWindow*3 (no unbounded growth)', async () => {
    const { client } = makeClient();
    const cfg: MemoryConfig = { ...baseConfig, recencyWindow: 2 }; // cap = 6
    const memory = new MemoraxMemory(baseScope, cfg, adapterOpts(client));

    for (let i = 0; i < 20; i++) {
      await memory.appendTurn({ turn: i, role: 'generate', content: `turn-${i}`, tokenCount: 1 });
    }
    await new Promise((r) => setTimeout(r, 0));

    const snap = await memory.snapshot();
    const recent = snap.recentEntries as MemoryEntry[];
    expect(recent.length).toBeLessThanOrEqual(30); // Math.max(2*3, 30) = 30
    expect(recent[recent.length - 1]!.content).toBe('turn-19');
  });
});

describe('MemoraxMemory · getRecentAsMessages', () => {
  it('maps role: receive→user, generate→assistant, system→assistant', async () => {
    const { client } = makeClient();
    const memory = new MemoraxMemory(baseScope, baseConfig, adapterOpts(client));

    await memory.appendTurn({ turn: 1, role: 'receive', content: 'hi', tokenCount: 1 });
    await memory.appendTurn({ turn: 1, role: 'generate', content: '答', tokenCount: 1 });
    await memory.pin('永记', []);

    const result = await memory.getRecentAsMessages({ budget: 1000 });

    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant']);
  });

  it('respects budget cap (stops before exceeding)', async () => {
    const { client } = makeClient();
    const memory = new MemoraxMemory(baseScope, baseConfig, adapterOpts(client));

    for (let i = 0; i < 4; i++) {
      await memory.appendTurn({ turn: i, role: 'generate', content: `t${i}`, tokenCount: 100 });
    }

    const result = await memory.getRecentAsMessages({ budget: 250 });

    expect(result.messages.length).toBe(2);
    expect(result.tokensUsed).toBe(200);
  });
});

describe('MemoraxMemory · snapshot / restore / reset', () => {
  it('snapshot kind is memorax-v1 + carries recentEntries + IDs', async () => {
    const { client } = makeClient();
    const memory = new MemoraxMemory(baseScope, baseConfig, adapterOpts(client));
    await memory.appendTurn({ turn: 1, role: 'generate', content: 'x', tokenCount: 1 });

    const snap = await memory.snapshot();

    expect(snap.kind).toBe('memorax-v1');
    expect(snap.userId).toBe('user-xyz');
    expect(snap.agentId).toBe('pt-abc');
    expect(snap.appId).toBe('ivn-editor');
    expect((snap.recentEntries as unknown[]).length).toBe(1);
  });

  it('restore rejects non-memorax snapshot kinds (adapter isolation)', async () => {
    const { client } = makeClient();
    const memory = new MemoraxMemory(baseScope, baseConfig, adapterOpts(client));

    expect(memory.restore({ kind: 'mem0-v1', recentEntries: [] })).rejects.toThrow(
      /MemoraxMemory cannot restore from kind/,
    );
  });

  it('restore round-trips recentEntries from memorax-v1 snapshot', async () => {
    const { client } = makeClient();
    const memory = new MemoraxMemory(baseScope, baseConfig, adapterOpts(client));
    await memory.appendTurn({ turn: 1, role: 'generate', content: 'orig', tokenCount: 1 });
    const snap = await memory.snapshot();

    const restored = new MemoraxMemory(baseScope, baseConfig, adapterOpts(client));
    await restored.restore(snap);
    const result = await restored.getRecentAsMessages({ budget: 1000 });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content).toBe('orig');
  });

  it('reset clears local recentEntries (cloud is not deletable; designed asymmetry)', async () => {
    const { client, calls } = makeClient();
    const memory = new MemoraxMemory(baseScope, baseConfig, adapterOpts(client));
    await memory.appendTurn({ turn: 1, role: 'generate', content: 'x', tokenCount: 1 });

    await memory.reset();
    const result = await memory.getRecentAsMessages({ budget: 1000 });

    expect(result.messages).toHaveLength(0);
    // reset 不调任何 HTTP（Memorax 没有 memory-delete API）
    const addCallsBefore = calls.add.length;
    expect(calls.search).toHaveLength(0);
    expect(calls.add.length).toBe(addCallsBefore); // unchanged after reset
  });
});

describe('entryToMemoraxMessage · role mapping', () => {
  it('receive → user', () => {
    expect(
      entryToMemoraxMessage({
        id: '1', turn: 1, role: 'receive', content: 'hi', tokenCount: 1,
        timestamp: 100, pinned: false,
      }),
    ).toEqual({ role: 'user', content: 'hi', timestamp: 100 });
  });

  it('generate → assistant', () => {
    expect(
      entryToMemoraxMessage({
        id: '1', turn: 1, role: 'generate', content: 'narr', tokenCount: 1,
        timestamp: 200, pinned: false,
      }),
    ).toEqual({ role: 'assistant', content: 'narr', timestamp: 200 });
  });

  it('system → assistant with [PINNED] prefix', () => {
    expect(
      entryToMemoraxMessage({
        id: '1', turn: -1, role: 'system', content: 'fact', tokenCount: 1,
        timestamp: 300, pinned: true,
      }),
    ).toEqual({ role: 'assistant', content: '[PINNED] fact', timestamp: 300 });
  });
});

describe('factory · provider:memorax', () => {
  it('throws clear error when memoraxConfig missing', async () => {
    expect(
      createMemory({
        scope: baseScope,
        config: { ...baseConfig, provider: 'memorax' },
      }),
    ).rejects.toThrow(/Memory provider "memorax" requires memoraxConfig/);
  });

  it('throws when only baseUrl set, apiKey missing', async () => {
    expect(
      createMemory({
        scope: baseScope,
        config: { ...baseConfig, provider: 'memorax' },
        memoraxConfig: { baseUrl: 'http://x', apiKey: '' },
      }),
    ).rejects.toThrow(/memoraxConfig/);
  });

  it('constructs MemoraxMemory when memoraxConfig is complete', async () => {
    const memory = await createMemory({
      scope: baseScope,
      config: { ...baseConfig, provider: 'memorax' },
      memoraxConfig: { baseUrl: 'http://memorax.test', apiKey: 'sk_test', appId: 'ivn-editor' },
    });
    expect(memory.kind).toBe('memorax');
  });
});
