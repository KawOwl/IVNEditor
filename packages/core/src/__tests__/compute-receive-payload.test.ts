/**
 * computeReceivePayload —— 把玩家输入 + 当前挂起的 choices 映射成
 * player_input entry 的结构化 payload（migration 0010 / Step 3）。
 *
 * 见 .claude/plans/conversation-persistence.md
 */

import { describe, it, expect } from 'bun:test';
import { computeReceivePayload } from '../game-session';

describe('computeReceivePayload', () => {
  it('choices null → freetext', () => {
    expect(computeReceivePayload('随便说点什么', null)).toEqual({ inputType: 'freetext' });
  });

  it('choices 空数组 → freetext', () => {
    expect(computeReceivePayload('想法', [])).toEqual({ inputType: 'freetext' });
  });

  it('text 精确命中某个 choice → choice + selectedIndex', () => {
    const choices = ['探索洞穴', '返回村庄', '休息一下'];
    expect(computeReceivePayload('返回村庄', choices)).toEqual({
      inputType: 'choice',
      selectedIndex: 1,
    });
  });

  it('text 命中首个 choice → selectedIndex=0', () => {
    const choices = ['A', 'B', 'C'];
    expect(computeReceivePayload('A', choices)).toEqual({
      inputType: 'choice',
      selectedIndex: 0,
    });
  });

  it('text 不匹配任何 choice（玩家自由输入）→ freetext', () => {
    const choices = ['探索洞穴', '返回村庄'];
    expect(computeReceivePayload('跳舞', choices)).toEqual({ inputType: 'freetext' });
  });

  it('text 部分匹配不算命中（strict equality）', () => {
    const choices = ['返回村庄一次'];
    // 完整 choice 是"返回村庄一次"，玩家输入"返回村庄"算不匹配
    expect(computeReceivePayload('返回村庄', choices)).toEqual({ inputType: 'freetext' });
  });

  it('重复 choices 命中第一个', () => {
    // 不常见但合法：LLM 给了重复选项。indexOf 返回第一个。
    const choices = ['好', '好', '不'];
    expect(computeReceivePayload('好', choices)).toEqual({
      inputType: 'choice',
      selectedIndex: 0,
    });
  });
});
