/**
 * messages-builder 单元测试
 *
 * 见 .claude/plans/messages-model.md "PR-M1 测试清单"。
 * 15+ 用例覆盖分组合并、batchId / 启发式、特殊情况。
 */

import { describe, it, expect } from 'bun:test';
import {
  buildMessagesFromEntries,
  capMessagesByBudgetFromTail,
  serializeMessagesForDebug,
} from '#internal/messages-builder';
import type { NarrativeEntry } from '#internal/persistence-entry';
import type { AssistantModelMessage, ModelMessage, ToolModelMessage, UserModelMessage } from 'ai';

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

  // ==========================================================================
  // A2 假设验证：batchId 分组 → orderIdx 顺序对合并结果不敏感
  //
  // 背景：recordPendingSignal 原本在 signal_input 事件前同步 flush 当前
  // narrative buffer，理由是"保证 narrative 在 signal_input 之前写 DB，避免
  // messages-builder 把它们拆成不同 assistant message"。
  //
  // 但 messages-builder 的实际合并逻辑是：
  //   1. 按 batchId 分组（相同 batchId → 同 group）
  //   2. group 内 narrative 全部 join 成 text block
  //   3. group 内 tool_call / signal_input 全部变成 tool-call blocks
  //   4. 固定顺序输出 assistant.content = [text, ...tool-calls]（不看 orderIdx）
  //
  // 所以只要 batchId 相同，signal_input entry 的 orderIdx 即便在 narrative
  // 之前也没问题。下面用例锁定这个行为，为后续删除 recordPendingSignal 里的
  // narrative flush 做 regression 保障。
  // ==========================================================================

  it('A1. signal_input orderIdx < narrative orderIdx 但同 batchId → 仍合并为一个 assistant (text + tool-call)', () => {
    // 模拟"不 flush"场景：signal_input entry 先写（orderIdx=0），
    // 之后 generate 返回 flush narrative 写（orderIdx=1），两者同 batchId
    const msgs = buildMessagesFromEntries([
      signalInput('你想做什么？', ['向左', '向右'], 'B1', 0),
      narrative('你站在岔路口，夕阳斜照在石板上。', 'B1', 1),
    ]);

    // 期望：一个 assistant + 一个 tool message（不因顺序颠倒就拆成两个 batch）
    expect(msgs).toHaveLength(2);

    const a = msgs[0] as AssistantModelMessage;
    expect(a.role).toBe('assistant');
    expect(Array.isArray(a.content)).toBe(true);
    const parts = a.content as any[];
    // 固定顺序：text 在 tool-call 之前
    expect(parts[0]).toEqual({ type: 'text', text: '你站在岔路口，夕阳斜照在石板上。' });
    expect(parts[1].type).toBe('tool-call');
    expect(parts[1].toolName).toBe('signal_input_needed');
    expect(parts[1].input).toEqual({ prompt_hint: '你想做什么？', choices: ['向左', '向右'] });

    // tool message 跟随
    const t = msgs[1] as ToolModelMessage;
    expect(t.role).toBe('tool');
    const tp = (t.content as any[])[0];
    expect(tp.toolName).toBe('signal_input_needed');
    expect(tp.toolCallId).toBe(parts[1].toolCallId);
  });

  it('A2. 多 narrative 散在 signal_input / tool_call 之间，同 batchId → 所有 narrative 合成一个 text block', () => {
    // 更极端的乱序：narrative 和 tool-call / signal_input 交替
    const msgs = buildMessagesFromEntries([
      signalInput('Q?', ['ok'], 'B1', 0),
      narrative('段一', 'B1', 1),
      toolCall('update_state', { x: 1 }, { ok: true }, 'B1', 2),
      narrative('段二', 'B1', 3),
    ]);
    expect(msgs).toHaveLength(2);
    const a = msgs[0] as AssistantModelMessage;
    const parts = a.content as any[];
    // text block：两段 narrative 按 orderIdx 升序拼接
    expect(parts[0]).toEqual({ type: 'text', text: '段一段二' });
    // tool-call 按 entries 扫描顺序加入（orderIdx 升序）：先 signal_input 再 update_state
    expect(parts[1].toolName).toBe('signal_input_needed');
    expect(parts[2].toolName).toBe('update_state');
  });

  it('A3. signal_input 不同 batchId（真实跨 step）→ 分开两个 assistant message', () => {
    // 假设 LLM 走了两个独立 step：step 1 narrative（无 signal），step 2 signal_input（无 narrative）
    // 两者不同 batchId，messages-builder 分两个 assistant message
    const msgs = buildMessagesFromEntries([
      narrative('第一步的叙事', 'B1', 0),
      signalInput('Q?', ['ok'], 'B2', 1),
    ]);
    expect(msgs).toHaveLength(3); // assistant(text) + assistant(tool-call) + tool
    expect(msgs[0]!.role).toBe('assistant');
    expect((msgs[0] as AssistantModelMessage).content).toBe('第一步的叙事');
    expect(msgs[1]!.role).toBe('assistant');
    const parts = (msgs[1] as AssistantModelMessage).content as any[];
    expect(parts[0].type).toBe('tool-call');
    expect(parts[0].toolName).toBe('signal_input_needed');
    expect(msgs[2]!.role).toBe('tool');
  });

  // -----------------------------------------------------------------
  // Reasoning（DeepSeek v4 thinking 模式兼容）
  // -----------------------------------------------------------------

  it('narrative entry 有 reasoning → assistant content 含 ReasoningPart', () => {
    const entries = [
      mkEntry({
        kind: 'narrative',
        role: 'generate',
        content: '你走进屋子。',
        reasoning: '玩家选择进屋，描绘空间过渡。',
        batchId: 'b1',
        orderIdx: 0,
      }),
      mkEntry({
        kind: 'tool_call',
        role: 'system',
        content: 'change_scene',
        payload: { input: { background: 'room' }, output: { ok: true } },
        batchId: 'b1',
        orderIdx: 1,
      }),
    ];
    const msgs = buildMessagesFromEntries(entries);
    expect(msgs).toHaveLength(2); // assistant + tool
    const asst = msgs[0] as AssistantModelMessage;
    expect(asst.role).toBe('assistant');
    const parts = asst.content as any[];
    expect(Array.isArray(parts)).toBe(true);
    expect(parts[0]).toEqual({ type: 'reasoning', text: '玩家选择进屋，描绘空间过渡。' });
    expect(parts[1]).toEqual({ type: 'text', text: '你走进屋子。' });
    expect(parts[2].type).toBe('tool-call');
    expect(parts[2].toolName).toBe('change_scene');
  });

  it('narrative entry reasoning=null → assistant content 无 ReasoningPart（老数据回放）', () => {
    const entries = [
      mkEntry({
        kind: 'narrative',
        role: 'generate',
        content: '纯叙事，无思考痕迹',
        reasoning: null,
        batchId: 'b1',
        orderIdx: 0,
      }),
      mkEntry({
        kind: 'tool_call',
        role: 'system',
        content: 'update_state',
        payload: { input: {}, output: { ok: true } },
        batchId: 'b1',
        orderIdx: 1,
      }),
    ];
    const msgs = buildMessagesFromEntries(entries);
    const asst = msgs[0] as AssistantModelMessage;
    const parts = asst.content as any[];
    const kinds = parts.map((p) => p.type);
    expect(kinds).not.toContain('reasoning');
    expect(kinds).toContain('text');
    expect(kinds).toContain('tool-call');
  });

  it('只有 narrative + reasoning，没有 tool-call → parts 数组含 reasoning + text（不 collapse 为 string）', () => {
    const entries = [
      mkEntry({
        kind: 'narrative',
        role: 'generate',
        content: '叙事正文',
        reasoning: '我的思考',
        batchId: 'b1',
        orderIdx: 0,
      }),
    ];
    const msgs = buildMessagesFromEntries(entries);
    expect(msgs).toHaveLength(1);
    const asst = msgs[0] as AssistantModelMessage;
    // 有 reasoning 就走结构化 parts，不走 string 简化形
    expect(Array.isArray(asst.content)).toBe(true);
    const parts = asst.content as any[];
    expect(parts).toHaveLength(2);
    expect(parts[0]).toEqual({ type: 'reasoning', text: '我的思考' });
    expect(parts[1]).toEqual({ type: 'text', text: '叙事正文' });
  });

  // ─── tool-only step stub（DeepSeek V4 thinking replay 修复，2026-04-25）─────
  // 见 game-session.mts persistToolOnlyStepReasoning 注释 + scripts/verify-deepseek-reasoning.mts case 6。
  // 修复落地后，tool-only step 会写 stub `narrative` entry：content='' + reasoning=非空 + 同 batch 的 tool_calls。
  // messages-builder 必须把这种组合投影成 `[ReasoningPart, ToolCallPart...]`（**不**带空 TextPart）。

  it('stub narrative (content="" + reasoning) + tool_calls 同 batch → parts 是 [reasoning, tool-call...]，无 text part', () => {
    const entries = [
      mkEntry({
        kind: 'narrative',
        role: 'generate',
        content: '',
        reasoning: '玩家进屋了，需要切场景再更新 chapter 计数',
        batchId: 'b1',
        orderIdx: 0,
      }),
      mkEntry({
        kind: 'tool_call',
        role: 'system',
        content: 'change_scene',
        payload: { input: { background: 'room' }, output: { ok: true } },
        batchId: 'b1',
        orderIdx: 1,
      }),
      mkEntry({
        kind: 'tool_call',
        role: 'system',
        content: 'update_state',
        payload: { input: { chapter: 2 }, output: { ok: true } },
        batchId: 'b1',
        orderIdx: 2,
      }),
    ];
    const msgs = buildMessagesFromEntries(entries);
    expect(msgs).toHaveLength(2); // assistant + tool
    const asst = msgs[0] as AssistantModelMessage;
    expect(asst.role).toBe('assistant');
    const parts = asst.content as any[];
    expect(Array.isArray(parts)).toBe(true);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({
      type: 'reasoning',
      text: '玩家进屋了，需要切场景再更新 chapter 计数',
    });
    expect(parts[1].type).toBe('tool-call');
    expect(parts[1].toolName).toBe('change_scene');
    expect(parts[2].type).toBe('tool-call');
    expect(parts[2].toolName).toBe('update_state');
    // 关键：不该插一个空 TextPart 进来——DeepSeek 对空 content 不挑剔，
    // 但白白多一个 part 会污染日志阅读
    expect(parts.find((p) => p.type === 'text')).toBeUndefined();
  });

  it('两 batch：tool-only stub batch + narrative batch → 各自 assistant 都带 reasoning_content', () => {
    // 模拟一次 generate() 内：step 1 tool-only（用 stub 落 reasoning）+ step 2 narrative
    const entries = [
      // batch b1: tool-only step 的 stub + 工具调用
      mkEntry({
        kind: 'narrative',
        role: 'generate',
        content: '',
        reasoning: 'step1 思考：先切场景',
        batchId: 'b1',
        orderIdx: 0,
      }),
      mkEntry({
        kind: 'tool_call',
        role: 'system',
        content: 'change_scene',
        payload: { input: { background: 'room' }, output: { ok: true } },
        batchId: 'b1',
        orderIdx: 1,
      }),
      // batch b2: 正常 narrative step
      mkEntry({
        kind: 'narrative',
        role: 'generate',
        content: '你走进屋子。',
        reasoning: 'step2 思考：描绘进屋的画面',
        batchId: 'b2',
        orderIdx: 2,
      }),
      mkEntry({
        kind: 'signal_input',
        role: 'system',
        content: '接下来呢？',
        payload: { choices: ['坐下', '环顾'] },
        batchId: 'b2',
        orderIdx: 3,
      }),
    ];
    const msgs = buildMessagesFromEntries(entries);
    // 期望：assistant(b1) + tool(b1) + assistant(b2) + tool(b2) = 4 条
    expect(msgs).toHaveLength(4);

    const asst1 = msgs[0] as AssistantModelMessage;
    const asst1Parts = asst1.content as any[];
    expect(asst1Parts[0]).toEqual({ type: 'reasoning', text: 'step1 思考：先切场景' });
    expect(asst1Parts.find((p) => p.type === 'text')).toBeUndefined();
    expect(asst1Parts.filter((p) => p.type === 'tool-call')).toHaveLength(1);

    const asst2 = msgs[2] as AssistantModelMessage;
    const asst2Parts = asst2.content as any[];
    expect(asst2Parts[0]).toEqual({
      type: 'reasoning',
      text: 'step2 思考：描绘进屋的画面',
    });
    expect(asst2Parts[1]).toEqual({ type: 'text', text: '你走进屋子。' });
    expect(asst2Parts.filter((p) => p.type === 'tool-call')).toHaveLength(1);
  });
});

// ============================================================================
// capMessagesByBudgetFromTail
// ============================================================================

describe('capMessagesByBudgetFromTail', () => {
  const mkUser = (s: string): ModelMessage => ({ role: 'user', content: s });
  const mkAsst = (s: string): ModelMessage => ({ role: 'assistant', content: s });

  it('budget 充足 → 全部保留', () => {
    const msgs = [mkUser('a'), mkAsst('b'), mkUser('c')];
    const r = capMessagesByBudgetFromTail(msgs, 10000);
    expect(r.messages).toEqual(msgs);
  });

  it('budget = 0 → 返回空', () => {
    const r = capMessagesByBudgetFromTail([mkUser('a')], 0);
    expect(r.messages).toEqual([]);
    expect(r.tokensUsed).toBe(0);
  });

  it('空输入 → 空输出', () => {
    const r = capMessagesByBudgetFromTail([], 100);
    expect(r.messages).toEqual([]);
  });

  it('预算紧 → 从尾部保留最新的若干条', () => {
    // 4 条消息，每条约 11 字 → token ~3/条；budget=8 → 大约保留最后 2 条
    const msgs = [
      mkUser('msg-oldest-1'),
      mkAsst('msg-old-2'),
      mkUser('msg-new-3'),
      mkAsst('msg-newest-4'),
    ];
    const r = capMessagesByBudgetFromTail(msgs, 6);
    // 保留最后几条，第一条"oldest-1"一定被丢弃
    expect(r.messages[r.messages.length - 1]).toEqual(mkAsst('msg-newest-4'));
    expect(r.messages.find((m) => m.content === 'msg-oldest-1')).toBeUndefined();
  });

  it('孤悬 tool 消息 → 往后挪 cutoff 剪掉', () => {
    // 构造场景：budget 恰好切出"仅留 tool 没留它之前的 assistant"的边界
    const assistant: AssistantModelMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'long long long narrative here ' + 'x'.repeat(100) },
        { type: 'tool-call', toolCallId: 'tc1', toolName: 'foo', input: { k: 'v' } },
      ],
    };
    const tool: ToolModelMessage = {
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 'tc1', toolName: 'foo', output: { type: 'json', value: { ok: true } } },
      ],
    };
    const user: ModelMessage = { role: 'user', content: 'short' };

    // budget 足够留 tool + user，但不够 assistant → 预期孤悬 tool 被剔，只留 user
    const r = capMessagesByBudgetFromTail([assistant, tool, user], 10);
    // 头部不应该是 tool
    expect(r.messages[0]?.role).not.toBe('tool');
    // user 一定保住
    expect(r.messages[r.messages.length - 1]).toEqual(user);
  });
});

// ============================================================================
// serializeMessagesForDebug
// ============================================================================

describe('serializeMessagesForDebug', () => {
  it('纯文本 assistant → {role, content: string}', () => {
    const out = serializeMessagesForDebug([{ role: 'assistant', content: '纯叙事' }]);
    expect(out).toEqual([{ role: 'assistant', content: '纯叙事' }]);
  });

  it('assistant 带 TextPart + ToolCallPart → text 拼行 + [tool-call] 行', () => {
    const msg: AssistantModelMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: '叙事正文' },
        { type: 'tool-call', toolCallId: 't1', toolName: 'change_scene', input: { bg: 'plaza' } },
      ],
    };
    const [out] = serializeMessagesForDebug([msg]);
    expect(out!.role).toBe('assistant');
    expect(out!.content).toContain('叙事正文');
    expect(out!.content).toContain('[tool-call]');
    expect(out!.content).toContain('change_scene');
  });

  it('tool role → 逐 part 标 [tool-result]', () => {
    const msg: ToolModelMessage = {
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 't1', toolName: 'change_scene', output: { type: 'json', value: { ok: true } } },
      ],
    };
    const [out] = serializeMessagesForDebug([msg]);
    expect(out!.role).toBe('tool');
    expect(out!.content).toContain('[tool-result]');
    expect(out!.content).toContain('change_scene');
  });
});
