/**
 * messages-builder 单元测试
 *
 * 见 .claude/plans/messages-model.md "PR-M1 测试清单"。
 * 15+ 用例覆盖分组合并、batchId / 启发式、特殊情况。
 */

import { describe, it, expect } from 'bun:test';
import { buildMessagesFromEntries } from '../messages-builder';
import type { NarrativeEntry } from '../persistence-entry';
import type { AssistantModelMessage, ToolModelMessage, UserModelMessage } from '@ai-sdk/provider-utils';

// ============================================================================
// Helpers
// ============================================================================

let nextId = 1;
function mkEntry(partial: Partial<NarrativeEntry> & Pick<NarrativeEntry, 'kind'>): NarrativeEntry {
  return {
    id: `e-${nextId++}`,
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

function narrative(content: string, batchId: string | null = null, orderIdx = 0): NarrativeEntry {
  return mkEntry({ kind: 'narrative', role: 'generate', content, batchId, orderIdx });
}

function signalInput(
  hint: string,
  choices: string[],
  batchId: string | null = null,
  orderIdx = 0,
): NarrativeEntry {
  return mkEntry({
    kind: 'signal_input',
    role: 'system',
    content: hint,
    payload: { choices },
    batchId,
    orderIdx,
  });
}

function toolCall(
  toolName: string,
  input: unknown,
  output: unknown,
  batchId: string | null = null,
  orderIdx = 0,
): NarrativeEntry {
  return mkEntry({
    kind: 'tool_call',
    role: 'system',
    content: toolName,
    payload: { input, output },
    batchId,
    orderIdx,
  });
}

function playerInput(
  text: string,
  batchId: string | null = null,
  orderIdx = 0,
  selectedIndex?: number,
): NarrativeEntry {
  const payload: Record<string, unknown> =
    selectedIndex !== undefined
      ? { inputType: 'choice', selectedIndex }
      : { inputType: 'freetext' };
  return mkEntry({
    kind: 'player_input',
    role: 'receive',
    content: text,
    payload,
    batchId,
    orderIdx,
  });
}

// ============================================================================
// Tests
// ============================================================================

describe('buildMessagesFromEntries', () => {
  it('1. empty entries → []', () => {
    expect(buildMessagesFromEntries([])).toEqual([]);
  });

  it('2. 单条 narrative → 单 assistant text', () => {
    const msgs = buildMessagesFromEntries([narrative('一段叙事', 'B1', 0)]);
    expect(msgs).toHaveLength(1);
    const m = msgs[0] as AssistantModelMessage;
    expect(m.role).toBe('assistant');
    expect(m.content).toBe('一段叙事');
  });

  it('3. 多条 narrative 同 batchId → 单 assistant，text 原文拼接', () => {
    const msgs = buildMessagesFromEntries([
      narrative('段落一。', 'B1', 0),
      narrative('段落二。', 'B1', 1),
      narrative('段落三。', 'B1', 2),
    ]);
    expect(msgs).toHaveLength(1);
    const m = msgs[0] as AssistantModelMessage;
    expect(m.content).toBe('段落一。段落二。段落三。');
  });

  it('4. narrative + signal_input 同 batch → assistant [text, tool-call] + tool [tool-result]', () => {
    const msgs = buildMessagesFromEntries([
      narrative('你站在岔路口。', 'B1', 0),
      signalInput('往哪走？', ['向左', '向右'], 'B1', 1),
    ]);
    expect(msgs).toHaveLength(2);

    const a = msgs[0] as AssistantModelMessage;
    expect(a.role).toBe('assistant');
    expect(Array.isArray(a.content)).toBe(true);
    const parts = a.content as any[];
    expect(parts[0]).toEqual({ type: 'text', text: '你站在岔路口。' });
    expect(parts[1].type).toBe('tool-call');
    expect(parts[1].toolName).toBe('signal_input_needed');
    expect(parts[1].input).toEqual({ prompt_hint: '往哪走？', choices: ['向左', '向右'] });

    const t = msgs[1] as ToolModelMessage;
    expect(t.role).toBe('tool');
    const tp = (t.content as any[])[0];
    expect(tp.type).toBe('tool-result');
    expect(tp.toolName).toBe('signal_input_needed');
    expect(tp.toolCallId).toBe(parts[1].toolCallId);
    expect(tp.output).toEqual({ type: 'json', value: { success: true } });
  });

  it('5. narrative + tool_call 同 batch → assistant [text, tool-call] + tool 含 tool-result', () => {
    const msgs = buildMessagesFromEntries([
      narrative('旁白。', 'B1', 0),
      toolCall('update_state', { key: 'trust', value: 2 }, { success: true, updated: ['trust'] }, 'B1', 1),
    ]);
    expect(msgs).toHaveLength(2);
    const a = msgs[0] as AssistantModelMessage;
    const parts = a.content as any[];
    expect(parts[0]).toEqual({ type: 'text', text: '旁白。' });
    expect(parts[1].toolName).toBe('update_state');
    expect(parts[1].input).toEqual({ key: 'trust', value: 2 });

    const tp = ((msgs[1] as ToolModelMessage).content as any[])[0];
    expect(tp.output).toEqual({
      type: 'json',
      value: { success: true, updated: ['trust'] },
    });
  });

  it('6. narrative + multiple tool_calls + signal_input 同 batch → assistant 含全部 tool-call，tool 含全部 tool-result', () => {
    const entries = [
      narrative('旁白。', 'B1', 0),
      toolCall('update_state', { a: 1 }, { ok: 1 }, 'B1', 1),
      toolCall('change_scene', { bg: 'forest' }, { ok: 2 }, 'B1', 2),
      signalInput('问题？', ['是', '否'], 'B1', 3),
    ];
    const msgs = buildMessagesFromEntries(entries);
    expect(msgs).toHaveLength(2);
    const a = msgs[0] as AssistantModelMessage;
    const parts = a.content as any[];
    expect(parts).toHaveLength(4); // text + 3 tool-call
    expect(parts[0].type).toBe('text');
    expect(parts[1].toolName).toBe('update_state');
    expect(parts[2].toolName).toBe('change_scene');
    expect(parts[3].toolName).toBe('signal_input_needed');

    const resultParts = (msgs[1] as ToolModelMessage).content as any[];
    expect(resultParts).toHaveLength(3);
    expect(resultParts.map((r: any) => r.toolName)).toEqual([
      'update_state',
      'change_scene',
      'signal_input_needed',
    ]);
  });

  it('7. 仅 signal_input，没有 narrative → assistant 只含 tool-call，无 text', () => {
    const msgs = buildMessagesFromEntries([signalInput('选', ['A', 'B'], 'B1', 0)]);
    expect(msgs).toHaveLength(2);
    const a = msgs[0] as AssistantModelMessage;
    const parts = a.content as any[];
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('tool-call');
    expect(parts[0].toolName).toBe('signal_input_needed');
  });

  it('8. 仅 tool_call，没有 narrative → assistant 只含 tool-call，无 text', () => {
    const msgs = buildMessagesFromEntries([
      toolCall('update_state', { x: 1 }, { ok: true }, 'B1', 0),
    ]);
    expect(msgs).toHaveLength(2);
    const a = msgs[0] as AssistantModelMessage;
    expect(Array.isArray(a.content)).toBe(true);
    expect((a.content as any[])[0].toolName).toBe('update_state');
  });

  it('9. 完整 turn cycle（LLM step + player + LLM step）→ 顺序正确', () => {
    const msgs = buildMessagesFromEntries([
      narrative('第 1 段。', 'B1', 0),
      signalInput('继续？', ['好'], 'B1', 1),
      playerInput('好', 'P1', 2, 0),
      narrative('第 2 段。', 'B2', 3),
      signalInput('再问', ['A', 'B'], 'B2', 4),
    ]);
    expect(msgs).toHaveLength(5); // assistant + tool + user + assistant + tool
    expect(msgs[0]!.role).toBe('assistant');
    expect(msgs[1]!.role).toBe('tool');
    expect(msgs[2]!.role).toBe('user');
    expect(msgs[3]!.role).toBe('assistant');
    expect(msgs[4]!.role).toBe('tool');

    expect((msgs[2] as UserModelMessage).content).toBe('好');
  });

  it('10. 连续两个 player_input（各自 batch）→ 两个 user messages', () => {
    const msgs = buildMessagesFromEntries([
      playerInput('第一句', 'P1', 0),
      playerInput('第二句', 'P2', 1),
    ]);
    expect(msgs).toHaveLength(2);
    expect((msgs[0] as UserModelMessage).role).toBe('user');
    expect((msgs[0] as UserModelMessage).content).toBe('第一句');
    expect((msgs[1] as UserModelMessage).content).toBe('第二句');
  });

  it('11. batchId=null 老数据：靠 player_input 作 turn boundary 分组', () => {
    const msgs = buildMessagesFromEntries([
      narrative('叙事1', null, 0),
      narrative('叙事2', null, 1),
      playerInput('回答1', null, 2),
      narrative('叙事3', null, 3),
    ]);
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.role).toBe('assistant');
    expect((msgs[0] as AssistantModelMessage).content).toBe('叙事1叙事2');
    expect((msgs[1] as UserModelMessage).content).toBe('回答1');
    expect((msgs[2] as AssistantModelMessage).content).toBe('叙事3');
  });

  it('12. 混合 batchId null 和非 null', () => {
    const msgs = buildMessagesFromEntries([
      narrative('老数据', null, 0),
      narrative('老数据2', null, 1),
      playerInput('老回答', null, 2),
      narrative('新数据', 'B1', 3),
      signalInput('问', ['ok'], 'B1', 4),
    ]);
    expect(msgs).toHaveLength(4);
    expect(msgs[0]!.role).toBe('assistant');
    expect(msgs[1]!.role).toBe('user');
    expect(msgs[2]!.role).toBe('assistant');
    expect(msgs[3]!.role).toBe('tool');
  });

  it('13. narrative 的 XML-lite 原文不被 normalize', () => {
    const raw = '她说：<d s="alice" to="bob">你来了。</d>\n\n他点点头。';
    const msgs = buildMessagesFromEntries([narrative(raw, 'B1', 0)]);
    const a = msgs[0] as AssistantModelMessage;
    expect(a.content).toBe(raw); // byte-for-byte 保留
  });

  it('14. toolCallId 在 assistant 和 tool 两端配对（用 entry.id）', () => {
    const entries = [
      narrative('文字', 'B1', 0),
      toolCall('X', {}, 'o1', 'B1', 1),
      toolCall('Y', {}, 'o2', 'B1', 2),
      signalInput('h', ['a'], 'B1', 3),
    ];
    // 手动赋 id 方便断言
    entries[1]!.id = 'id-X';
    entries[2]!.id = 'id-Y';
    entries[3]!.id = 'id-S';

    const msgs = buildMessagesFromEntries(entries);
    const assistantParts = (msgs[0] as AssistantModelMessage).content as any[];
    const toolParts = (msgs[1] as ToolModelMessage).content as any[];

    expect(assistantParts[1].toolCallId).toBe('id-X');
    expect(assistantParts[2].toolCallId).toBe('id-Y');
    expect(assistantParts[3].toolCallId).toBe('id-S');

    expect(toolParts[0].toolCallId).toBe('id-X');
    expect(toolParts[1].toolCallId).toBe('id-Y');
    expect(toolParts[2].toolCallId).toBe('id-S');
  });

  it('15. 乱序 orderIdx 输入 → builder 先排序再组装', () => {
    // 故意乱序
    const msgs = buildMessagesFromEntries([
      narrative('第三段', 'B1', 2),
      narrative('第一段', 'B1', 0),
      narrative('第二段', 'B1', 1),
    ]);
    const a = msgs[0] as AssistantModelMessage;
    expect(a.content).toBe('第一段第二段第三段');
  });

  it('16. 两个明确不同 batchId 连续（无 player boundary）→ 切成两个 assistant/tool 对', () => {
    // 这种情况在 MVP 下不会发生（一次 generate 只产一个 batch），
    // 但 builder 需要稳定处理 —— 按 batchId 切开
    const msgs = buildMessagesFromEntries([
      narrative('A1', 'B1', 0),
      signalInput('?', ['ok'], 'B1', 1),
      narrative('A2', 'B2', 2),
      signalInput('?', ['ok'], 'B2', 3),
    ]);
    expect(msgs).toHaveLength(4);
    expect(msgs[0]!.role).toBe('assistant');
    expect(msgs[1]!.role).toBe('tool');
    expect(msgs[2]!.role).toBe('assistant');
    expect(msgs[3]!.role).toBe('tool');
  });

  it('17. opts.wrapToolOutput 自定义 output 包装', () => {
    const msgs = buildMessagesFromEntries(
      [toolCall('X', { a: 1 }, 'plain text', 'B1', 0)],
      {
        wrapToolOutput: (output) => ({ type: 'json', value: { wrapped: output } }),
      },
    );
    const toolPart = ((msgs[1] as ToolModelMessage).content as any[])[0];
    expect(toolPart.output).toEqual({ type: 'json', value: { wrapped: 'plain text' } });
  });
});
