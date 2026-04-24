/**
 * persistence-entry —— TS 类型守卫单测。
 *
 * 见 .claude/plans/messages-model.md
 */

import { describe, it, expect } from 'bun:test';
import {
  isKnownEntryKind,
  isNarrativeEntry,
  isSignalInputEntry,
  isToolCallEntry,
  isPlayerInputEntry,
  readSelectedIndex,
  readChoices,
  KNOWN_ENTRY_KINDS,
} from '../persistence-entry';
import type { NarrativeEntry } from '../persistence-entry';

function makeEntry(partial: Partial<NarrativeEntry> & Pick<NarrativeEntry, 'kind'>): NarrativeEntry {
  return {
    id: 'test-id',
    playthroughId: 'pt-1',
    role: 'generate',
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

describe('isKnownEntryKind', () => {
  it('认所有 4 种 kind', () => {
    for (const kind of KNOWN_ENTRY_KINDS) {
      expect(isKnownEntryKind(kind)).toBe(true);
    }
  });

  it('拒绝未知 kind', () => {
    expect(isKnownEntryKind('unknown')).toBe(false);
    expect(isKnownEntryKind('')).toBe(false);
    expect(isKnownEntryKind('NARRATIVE')).toBe(false); // 大小写敏感
  });
});

describe('isNarrativeEntry', () => {
  it('narrative kind → true', () => {
    expect(isNarrativeEntry(makeEntry({ kind: 'narrative' }))).toBe(true);
  });
  it('其他 kind → false', () => {
    expect(isNarrativeEntry(makeEntry({ kind: 'signal_input' }))).toBe(false);
    expect(isNarrativeEntry(makeEntry({ kind: 'player_input' }))).toBe(false);
    expect(isNarrativeEntry(makeEntry({ kind: 'tool_call' }))).toBe(false);
  });
});

describe('isSignalInputEntry', () => {
  it('正确 shape → true', () => {
    const e = makeEntry({
      kind: 'signal_input',
      payload: { choices: ['A', 'B'] },
    });
    expect(isSignalInputEntry(e)).toBe(true);
  });

  it('kind 不匹配 → false', () => {
    expect(
      isSignalInputEntry(makeEntry({ kind: 'narrative', payload: { choices: ['A'] } })),
    ).toBe(false);
  });

  it('payload 缺 choices → false', () => {
    expect(
      isSignalInputEntry(makeEntry({ kind: 'signal_input', payload: { notChoices: 1 } })),
    ).toBe(false);
  });

  it('payload null → false', () => {
    expect(isSignalInputEntry(makeEntry({ kind: 'signal_input', payload: null }))).toBe(false);
  });

  it('choices 不是数组 → false', () => {
    expect(
      isSignalInputEntry(makeEntry({ kind: 'signal_input', payload: { choices: 'oops' as any } })),
    ).toBe(false);
  });
});

describe('isToolCallEntry', () => {
  it('正确 shape → true', () => {
    const e = makeEntry({
      kind: 'tool_call',
      content: 'update_state',
      payload: { input: { key: 'trust', value: 2 }, output: { success: true } },
    });
    expect(isToolCallEntry(e)).toBe(true);
  });

  it('kind 不匹配 → false', () => {
    expect(
      isToolCallEntry(makeEntry({ kind: 'narrative', payload: { input: 1, output: 2 } })),
    ).toBe(false);
  });

  it('payload 缺 input 或 output → false', () => {
    expect(
      isToolCallEntry(makeEntry({ kind: 'tool_call', payload: { input: 1 } })),
    ).toBe(false);
    expect(
      isToolCallEntry(makeEntry({ kind: 'tool_call', payload: { output: 2 } })),
    ).toBe(false);
  });

  it('payload null → false', () => {
    expect(isToolCallEntry(makeEntry({ kind: 'tool_call', payload: null }))).toBe(false);
  });

  it('允许 input/output 为 null（某些工具 output 为 null 合法）', () => {
    const e = makeEntry({
      kind: 'tool_call',
      content: 'clear_stage',
      payload: { input: null, output: null },
    });
    expect(isToolCallEntry(e)).toBe(true);
  });
});

describe('isPlayerInputEntry', () => {
  it('player_input kind → true（payload 为空也算）', () => {
    expect(isPlayerInputEntry(makeEntry({ kind: 'player_input' }))).toBe(true);
    expect(
      isPlayerInputEntry(
        makeEntry({ kind: 'player_input', payload: { inputType: 'choice', selectedIndex: 1 } }),
      ),
    ).toBe(true);
  });

  it('其他 kind → false', () => {
    expect(isPlayerInputEntry(makeEntry({ kind: 'narrative' }))).toBe(false);
  });
});

describe('readSelectedIndex', () => {
  it('选项路径 → 返回数字', () => {
    const e = makeEntry({
      kind: 'player_input',
      payload: { inputType: 'choice', selectedIndex: 2 },
    });
    expect(readSelectedIndex(e)).toBe(2);
  });

  it('freetext payload → undefined', () => {
    const e = makeEntry({
      kind: 'player_input',
      payload: { inputType: 'freetext' },
    });
    expect(readSelectedIndex(e)).toBeUndefined();
  });

  it('payload null → undefined', () => {
    expect(readSelectedIndex(makeEntry({ kind: 'player_input', payload: null }))).toBeUndefined();
  });

  it('非 player_input → undefined', () => {
    expect(readSelectedIndex(makeEntry({ kind: 'narrative' }))).toBeUndefined();
  });
});

describe('readChoices', () => {
  it('正常 → 返回 choices 数组', () => {
    const e = makeEntry({
      kind: 'signal_input',
      payload: { choices: ['探索', '休息'] },
    });
    expect(readChoices(e)).toEqual(['探索', '休息']);
  });

  it('非 signal_input → 空数组', () => {
    expect(readChoices(makeEntry({ kind: 'narrative' }))).toEqual([]);
  });

  it('payload null → 空数组', () => {
    expect(readChoices(makeEntry({ kind: 'signal_input', payload: null }))).toEqual([]);
  });
});
