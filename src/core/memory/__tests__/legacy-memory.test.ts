/**
 * LegacyMemory · Memory Refactor v2
 *
 * 见 .claude/plans/memory-refactor-v2.md
 *
 * 关键覆盖：
 *   - reader-based getRecentAsMessages（从 narrative_entries 拉 + role 翻译）
 *   - reader-based retrieve（keyword match 在 reader 数据上跑 + summary 拼接）
 *   - pin_memory → state.pinned → 进 retrieve summary
 *   - snapshot v2 格式（无 entries 字段）
 *   - restore v1 snapshot 兼容（从 entries.pinned=true 提取）
 *   - reader 未注入时 adapter 不崩溃（返回空数据）
 */

import { describe, it, expect } from 'bun:test';
import { LegacyMemory } from '../legacy/manager';
import type { NarrativeHistoryReader } from '../narrative-reader';
import type { NarrativeEntry, EntryKind } from '../../persistence-entry';
import type { MemoryConfig, MemoryEntry } from '../../types';

// ============================================================================
// Helpers
// ============================================================================

function mkEntry(partial: Partial<NarrativeEntry> & Pick<NarrativeEntry, 'kind' | 'content'>): NarrativeEntry {
  return {
    id: `e-${Math.random().toString(36).slice(2, 8)}`,
    playthroughId: 'pt-1',
    role: partial.kind === 'player_input' ? 'receive' : 'generate',
    content: '',
    payload: null,
    reasoning: null,
    finishReason: null,
    batchId: null,
    orderIdx: 0,
    createdAt: new Date(0),
    ...partial,
  };
}

function fakeReader(entries: NarrativeEntry[]): NarrativeHistoryReader {
  return {
    async readRecent({ limit, kinds }) {
      const filtered = kinds ? entries.filter((e) => kinds.includes(e.kind as EntryKind)) : entries;
      // 按 orderIdx 升序 + take last `limit`
      const sorted = [...filtered].sort((a, b) => a.orderIdx - b.orderIdx);
      return sorted.slice(-limit);
    },
    async readRange({ fromOrderIdx, toOrderIdx }) {
      return entries.filter((e) => {
        if (fromOrderIdx !== undefined && e.orderIdx < fromOrderIdx) return false;
        if (toOrderIdx !== undefined && e.orderIdx > toOrderIdx) return false;
        return true;
      }).sort((a, b) => a.orderIdx - b.orderIdx);
    },
  };
}

const baseConfig: MemoryConfig = {
  contextBudget: 100000,
  compressionThreshold: 50000,
  recencyWindow: 5,
  provider: 'legacy',
};

// Noop compress fn (legacy 默认的 truncatingCompressFn 走同路径，这里给个简单版本)
const noopCompress = async (entries: MemoryEntry[]) =>
  entries.map((e) => `[${e.role}] ${e.content.slice(0, 100)}`).join('\n');

// ============================================================================
// Tests
// ============================================================================

describe('LegacyMemory · reader-based', () => {
  describe('getRecentAsMessages', () => {
    it('读 reader 的 narrative / player_input entries，role 翻译正确', async () => {
      const reader = fakeReader([
        mkEntry({ kind: 'narrative', content: '旁白1', orderIdx: 0 }),
        mkEntry({ kind: 'player_input', content: '玩家1', orderIdx: 1 }),
        mkEntry({ kind: 'narrative', content: '旁白2', orderIdx: 2 }),
      ]);
      const mem = new LegacyMemory(baseConfig, noopCompress, reader);
      const { messages } = await mem.getRecentAsMessages({ budget: 100000 });

      expect(messages).toEqual([
        { role: 'assistant', content: '旁白1' },
        { role: 'user', content: '玩家1' },
        { role: 'assistant', content: '旁白2' },
      ]);
    });

    it('跳过 signal_input / tool_call（不进 messages）', async () => {
      const reader = fakeReader([
        mkEntry({ kind: 'narrative', content: '旁白', orderIdx: 0 }),
        mkEntry({ kind: 'signal_input', role: 'system', content: 'Q?', payload: { choices: ['A'] }, orderIdx: 1 }),
        mkEntry({ kind: 'tool_call', role: 'system', content: 'update_state', payload: { input: {}, output: {} }, orderIdx: 2 }),
        mkEntry({ kind: 'player_input', content: '回答', orderIdx: 3 }),
      ]);
      const mem = new LegacyMemory(baseConfig, noopCompress, reader);
      const { messages } = await mem.getRecentAsMessages({ budget: 100000 });

      expect(messages).toEqual([
        { role: 'assistant', content: '旁白' },
        { role: 'user', content: '回答' },
      ]);
    });

    it('reader 未注入（legacy 单测场景）→ 返回空', async () => {
      const mem = new LegacyMemory(baseConfig, noopCompress);
      const { messages } = await mem.getRecentAsMessages({ budget: 100000 });
      expect(messages).toEqual([]);
    });

    it('recencyWindow 生效', async () => {
      const entries = Array.from({ length: 10 }, (_, i) =>
        mkEntry({ kind: 'narrative', content: `n${i}`, orderIdx: i }),
      );
      const reader = fakeReader(entries);
      const mem = new LegacyMemory({ ...baseConfig, recencyWindow: 3 }, noopCompress, reader);
      const { messages } = await mem.getRecentAsMessages({ budget: 100000 });
      expect(messages.map((m) => m.content)).toEqual(['n7', 'n8', 'n9']);
    });
  });

  describe('retrieve', () => {
    it('summary = 空 + entries match', async () => {
      const reader = fakeReader([
        mkEntry({ kind: 'narrative', content: '你在森林里 遇到了狼', orderIdx: 0 }),
        mkEntry({ kind: 'narrative', content: '你在城堡里', orderIdx: 1 }),
      ]);
      const mem = new LegacyMemory(baseConfig, noopCompress, reader);
      const { summary, entries } = await mem.retrieve('森林');
      expect(summary).toBe('');
      expect(entries?.length).toBe(1);
      expect(entries?.[0]!.content).toContain('森林');
    });

    it('空 query → entries 空数组', async () => {
      const reader = fakeReader([
        mkEntry({ kind: 'narrative', content: '叙事内容', orderIdx: 0 }),
      ]);
      const mem = new LegacyMemory(baseConfig, noopCompress, reader);
      const { entries } = await mem.retrieve('');
      expect(entries).toEqual([]);
    });
  });

  describe('pin + retrieve summary', () => {
    it('pin 进 state.pinned，retrieve summary 含 [重要] 前缀', async () => {
      const mem = new LegacyMemory(baseConfig, noopCompress);
      await mem.pin('这是关键线索');
      await mem.pin('另一条要记住的');

      const { summary } = await mem.retrieve('');
      expect(summary).toContain('[重要] 这是关键线索');
      expect(summary).toContain('[重要] 另一条要记住的');
    });
  });

  describe('snapshot v2', () => {
    it('kind=legacy-v2，含 summaries + pinned + compressedUpTo，不含 entries', async () => {
      const mem = new LegacyMemory(baseConfig, noopCompress);
      await mem.pin('要记住');
      const snap = await mem.snapshot();
      expect(snap.kind).toBe('legacy-v2');
      expect(snap.pinned).toBeDefined();
      expect(Array.isArray(snap.pinned)).toBe(true);
      expect((snap.pinned as MemoryEntry[]).length).toBe(1);
      expect(snap.compressedUpTo).toBe(-1);
      // v2 不含 entries 字段
      expect(snap.entries).toBeUndefined();
    });
  });

  describe('restore 兼容', () => {
    it('restore v2 snapshot', async () => {
      const mem = new LegacyMemory(baseConfig, noopCompress);
      await mem.restore({
        kind: 'legacy-v2',
        summaries: ['过去的摘要'],
        pinned: [
          {
            id: 'p1',
            turn: -1,
            role: 'system',
            content: '老 pin',
            tokenCount: 10,
            timestamp: 0,
            pinned: true,
          },
        ],
        compressedUpTo: 42,
      });
      const { summary } = await mem.retrieve('');
      expect(summary).toContain('过去的摘要');
      expect(summary).toContain('[重要] 老 pin');
    });

    it('restore v1 snapshot（老格式兼容）—— 从 entries.pinned=true 提取', async () => {
      const mem = new LegacyMemory(baseConfig, noopCompress);
      await mem.restore({
        kind: 'legacy-v1',
        summaries: ['老 summary'],
        entries: [
          { id: 'a', turn: 1, role: 'generate', content: '旁白', tokenCount: 5, timestamp: 0, pinned: false },
          { id: 'b', turn: -1, role: 'system', content: '老的重要记忆', tokenCount: 8, timestamp: 0, pinned: true },
          { id: 'c', turn: 2, role: 'receive', content: '玩家输入', tokenCount: 3, timestamp: 0, pinned: false },
        ],
      });

      const { summary } = await mem.retrieve('');
      expect(summary).toContain('老 summary');
      expect(summary).toContain('[重要] 老的重要记忆');
      // 非 pinned 的 entries 不进 summary（已归 reader 管）
      expect(summary).not.toContain('旁白');
      expect(summary).not.toContain('玩家输入');
    });

    it('restore 未知 kind → 抛错', async () => {
      const mem = new LegacyMemory(baseConfig, noopCompress);
      await expect(
        mem.restore({ kind: 'llm-summarizer-v1', summaries: [], entries: [] }),
      ).rejects.toThrow(/cannot restore/);
    });
  });

  describe('reset', () => {
    it('清空所有 state（summaries / pinned / compressedUpTo）', async () => {
      const mem = new LegacyMemory(baseConfig, noopCompress);
      await mem.pin('x');
      await mem.reset();
      const snap = await mem.snapshot();
      expect(snap.pinned).toEqual([]);
      expect(snap.summaries).toEqual([]);
      expect(snap.compressedUpTo).toBe(-1);
    });
  });
});
