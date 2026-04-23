/**
 * narrative-entry-mapping —— NarrativeEntry → MemoryEntry 映射单测。
 *
 * 见 .claude/plans/memory-refactor-v2.md
 */

import { describe, it, expect } from 'bun:test';
import {
  narrativeToMemoryEntry,
  narrativeEntriesToMemoryEntries,
} from '../memory/narrative-entry-mapping';
import type { NarrativeEntry } from '../persistence-entry';

function mk(partial: Partial<NarrativeEntry> & Pick<NarrativeEntry, 'kind'>): NarrativeEntry {
  return {
    id: 'e-1',
    playthroughId: 'pt-1',
    role: 'generate',
    content: '',
    payload: null,
    reasoning: null,
    finishReason: null,
    batchId: null,
    orderIdx: 0,
    createdAt: new Date(1700000000000),
    ...partial,
  };
}

describe('narrativeToMemoryEntry', () => {
  it('narrative → role=generate', () => {
    const result = narrativeToMemoryEntry(
      mk({ kind: 'narrative', content: '叙事段落一。' }),
    );
    expect(result).not.toBeNull();
    expect(result!.role).toBe('generate');
    expect(result!.content).toBe('叙事段落一。');
    expect(result!.pinned).toBe(false);
    expect(result!.tokenCount).toBeGreaterThan(0);
    expect(result!.timestamp).toBe(1700000000000);
  });

  it('player_input → role=receive', () => {
    const result = narrativeToMemoryEntry(
      mk({ kind: 'player_input', content: '我选择探索洞穴' }),
    );
    expect(result).not.toBeNull();
    expect(result!.role).toBe('receive');
    expect(result!.content).toBe('我选择探索洞穴');
  });

  it('signal_input → null（跳过）', () => {
    expect(
      narrativeToMemoryEntry(
        mk({
          kind: 'signal_input',
          content: 'Q?',
          payload: { choices: ['A', 'B'] },
        }),
      ),
    ).toBeNull();
  });

  it('tool_call → null（跳过）', () => {
    expect(
      narrativeToMemoryEntry(
        mk({
          kind: 'tool_call',
          content: 'update_state',
          payload: { input: {}, output: {} },
        }),
      ),
    ).toBeNull();
  });

  it('保留 NarrativeEntry.id 作为 MemoryEntry.id', () => {
    const result = narrativeToMemoryEntry(
      mk({ id: 'custom-entry-id', kind: 'narrative', content: 'x' }),
    );
    expect(result!.id).toBe('custom-entry-id');
  });
});

describe('narrativeEntriesToMemoryEntries', () => {
  it('过滤掉 null，保留顺序', () => {
    const input: NarrativeEntry[] = [
      mk({ id: 'a', kind: 'narrative', content: '旁白1' }),
      mk({ id: 'b', kind: 'signal_input', content: 'Q?', payload: { choices: ['A'] } }),
      mk({ id: 'c', kind: 'player_input', content: 'A' }),
      mk({ id: 'd', kind: 'tool_call', content: 'update_state', payload: { input: {}, output: {} } }),
      mk({ id: 'e', kind: 'narrative', content: '旁白2' }),
    ];
    const result = narrativeEntriesToMemoryEntries(input);
    expect(result.map((e) => e.id)).toEqual(['a', 'c', 'e']);
    expect(result.map((e) => e.role)).toEqual(['generate', 'receive', 'generate']);
  });

  it('空输入 → 空输出', () => {
    expect(narrativeEntriesToMemoryEntries([])).toEqual([]);
  });

  it('全部是跳过的 kind → 空输出', () => {
    const input: NarrativeEntry[] = [
      mk({ kind: 'signal_input', payload: { choices: [] } }),
      mk({ kind: 'tool_call', payload: { input: {}, output: {} } }),
    ];
    expect(narrativeEntriesToMemoryEntries(input)).toEqual([]);
  });
});
