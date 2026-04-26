/**
 * NoopMemory · 评测零基线
 *
 * 关键覆盖：
 *   - retrieve 永远空 summary（context-assembler 不会生成 _engine_memory section）
 *   - getRecentAsMessages 仍然走 reader 投影 chat 历史（DeepSeek thinking 协议
 *     依赖此通道，noop 不能把它一起 nuke）
 *   - appendTurn / pin / maybeCompact 不影响内部状态（snapshot 始终空）
 *   - snapshot kind 隔离：拒绝其他 adapter 的 snapshot
 *   - factory 通过 provider:'noop' 能 spin 出 NoopMemory
 */

import { describe, it, expect } from 'bun:test';
import { NoopMemory } from '#internal/memory/noop/adapter';
import { createMemory } from '#internal/memory/factory';
import type {
  CoreEventHistoryItem,
  CoreEventHistoryReader,
} from '#internal/game-session/core-event-history';
import {
  batchId as toBatchId,
  inputRequestId as toInputRequestId,
  turnId as toTurnId,
} from '#internal/game-session/core-events';
import type { MemoryConfig } from '@ivn/core/types';

const emptyScene = { background: null, sprites: [] };

function mkItem(sequence: number, event: CoreEventHistoryItem['event']): CoreEventHistoryItem {
  return { sequence, occurredAt: sequence * 1000, event };
}

function fakeReader(items: CoreEventHistoryItem[]): CoreEventHistoryReader {
  const sorted = [...items].sort((a, b) => a.sequence - b.sequence);
  return {
    async readRecent({ limit }) {
      return sorted.slice(-limit);
    },
    async readRange({ fromSequence, toSequence }) {
      return sorted.filter((item) =>
        (fromSequence === undefined || item.sequence >= fromSequence) &&
        (toSequence === undefined || item.sequence <= toSequence),
      );
    },
  };
}

const baseConfig: MemoryConfig = {
  contextBudget: 100000,
  compressionThreshold: 100000,
  recencyWindow: 4,
};

describe('NoopMemory', () => {
  it('retrieve always returns empty summary regardless of pinned/append calls', async () => {
    const memory = new NoopMemory(baseConfig);
    await memory.appendTurn({ turn: 1, role: 'generate', content: '一段叙事', tokenCount: 5 });
    await memory.pin('永远记住这件事', ['important']);

    const result = await memory.retrieve();

    expect(result.summary).toBe('');
    expect(result.entries ?? []).toEqual([]);
  });

  it('getRecentAsMessages projects recent chat history via reader (chat history is not "memory")', async () => {
    const reader = fakeReader([
      mkItem(1, {
        type: 'narrative-batch-emitted',
        turnId: toTurnId(1),
        batchId: toBatchId('batch-1'),
        sentences: [{
          kind: 'narration',
          text: '开场旁白',
          sceneRef: emptyScene,
          turnNumber: 1,
          index: 0,
        }],
        scratches: [],
        degrades: [],
        sceneAfter: emptyScene,
      }),
      mkItem(2, {
        type: 'player-input-recorded',
        turnId: toTurnId(1),
        requestId: toInputRequestId(1),
        batchId: toBatchId('receive-1')!,
        text: '继续',
        payload: { inputType: 'freetext' },
        sentence: {
          kind: 'player_input',
          text: '继续',
          sceneRef: emptyScene,
          turnNumber: 1,
          index: 1,
        },
        snapshot: {
          turn: 1,
          stateVars: {},
          memorySnapshot: {},
          currentScene: emptyScene,
        },
      }),
    ]);
    const memory = new NoopMemory(baseConfig, reader);

    const result = await memory.getRecentAsMessages({ budget: 1000 });

    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.tokensUsed).toBeGreaterThan(0);
  });

  it('getRecentAsMessages returns empty when no reader injected (single-test fallback)', async () => {
    const memory = new NoopMemory(baseConfig);
    const result = await memory.getRecentAsMessages({ budget: 1000 });
    expect(result.messages).toEqual([]);
    expect(result.tokensUsed).toBe(0);
  });

  it('snapshot is byte-stable across appendTurn/pin/maybeCompact (no internal state)', async () => {
    const memory = new NoopMemory(baseConfig, fakeReader([]));
    const before = await memory.snapshot();
    await memory.appendTurn({ turn: 1, role: 'generate', content: 'x', tokenCount: 1 });
    await memory.pin('y');
    await memory.maybeCompact();
    const after = await memory.snapshot();
    expect(after).toEqual(before);
    expect(after).toEqual({ kind: 'noop-v1' });
  });

  it('restore rejects non-noop snapshot kinds (adapter isolation)', async () => {
    const memory = new NoopMemory(baseConfig);
    expect(memory.restore({ kind: 'legacy-v2', summaries: [], pinned: [] })).rejects.toThrow(
      /NoopMemory cannot restore from kind/,
    );
  });

  it('restore accepts noop-v1 snapshot (round-trip)', async () => {
    const memory = new NoopMemory(baseConfig);
    await memory.restore({ kind: 'noop-v1' });
    expect(await memory.snapshot()).toEqual({ kind: 'noop-v1' });
  });

  it('factory creates NoopMemory when provider is "noop"', async () => {
    const memory = await createMemory({
      scope: { playthroughId: 'pt-1', userId: 'u-1' },
      config: { ...baseConfig, provider: 'noop' },
      coreEventReader: fakeReader([]),
    });
    expect(memory.kind).toBe('noop');
  });
});
