/**
 * messages-builder —— 把 narrative_entries 序列投影成 LLM 可消费的 ModelMessage[]。
 *
 * 见 .claude/plans/messages-model.md
 *
 * 核心契约：
 *   - 纯函数，无副作用、无 I/O，可以任意 batch 调用
 *   - 输入 entries 必须属于同一 playthrough；orderIdx 会被排序，不要求调用方预排
 *   - 输出 messages 顺序严格按 LLM 时序：assistant → tool → user → assistant → ...
 *
 * 典型消费者：memory adapter 的 getRecentAsMessages() 内部（不是 coreLoop 直接调）。
 */

import type {
  ModelMessage,
  AssistantModelMessage,
  ToolModelMessage,
  UserModelMessage,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from '@ai-sdk/provider-utils';

import {
  isNarrativeEntry,
  isSignalInputEntry,
  isToolCallEntry,
  isPlayerInputEntry,
  readChoices,
  type NarrativeEntry,
} from './persistence-entry';

// ============================================================================
// Public API
// ============================================================================

export interface BuildMessagesOptions {
  /**
   * 自定义 tool-result 的 output 序列化。默认 `{type:'json', value: output}`。
   * 非标量 output 可能需要 provider-specific 适配。
   */
  wrapToolOutput?: (output: unknown) => { type: 'json'; value: unknown };
}

/**
 * 把 entries 投影成 ModelMessage[]。
 *
 * 规则（见 .claude/plans/messages-model.md）：
 *   1. 按 orderIdx 升序排序
 *   2. 按 batchId 分组：
 *      - 两端都有明确 batchId 且相等 → 同组
 *      - 两端都有明确 batchId 但不同 → 切
 *      - 任一 null（老数据兼容）→ 用 kind 启发式：非 player_input 连续 → 同组；
 *        跨越 player_input 边界 → 切
 *   3. 每组投影：
 *      - 只含 player_input entries → 合成 user message
 *      - 含 narrative / signal_input / tool_call 的混合组 → assistant message
 *        （可能配 tool message 带 tool-result）
 */
export function buildMessagesFromEntries(
  entries: NarrativeEntry[],
  opts?: BuildMessagesOptions,
): ModelMessage[] {
  if (entries.length === 0) return [];

  const sorted = [...entries].sort((a, b) => a.orderIdx - b.orderIdx);
  const groups = groupEntries(sorted);

  const messages: ModelMessage[] = [];
  for (const group of groups) {
    messages.push(...buildMessagesFromGroup(group, opts));
  }
  return messages;
}

// ============================================================================
// Grouping
// ============================================================================

/**
 * 分组规则：
 *   - 两端 batchId 都有值且相等 → 同组
 *   - 两端 batchId 都有值且不等 → 切
 *   - 至少一端 null → 按 kind 启发式：
 *       * 都是"LLM 侧"（非 player_input）→ 同组
 *       * 否则（任一是 player_input，或跨越 player_input 边界）→ 切
 */
function groupEntries(entries: NarrativeEntry[]): NarrativeEntry[][] {
  const groups: NarrativeEntry[][] = [];
  let current: NarrativeEntry[] = [];

  for (const entry of entries) {
    if (current.length === 0) {
      current.push(entry);
      continue;
    }
    const prev = current[current.length - 1]!;

    // 1. 两端都有明确 batchId
    if (prev.batchId !== null && entry.batchId !== null) {
      if (prev.batchId === entry.batchId) {
        current.push(entry);
      } else {
        groups.push(current);
        current = [entry];
      }
      continue;
    }

    // 2. 至少一端 null —— 启发式（按 kind）
    const prevIsLlmSide = prev.kind !== 'player_input';
    const entryIsLlmSide = entry.kind !== 'player_input';
    if (prevIsLlmSide && entryIsLlmSide) {
      current.push(entry);
    } else {
      // 边界：LLM side ↔ player 切换 / 两个 player_input 之间 —— 切
      groups.push(current);
      current = [entry];
    }
  }

  if (current.length > 0) groups.push(current);
  return groups;
}

// ============================================================================
// Per-group projection
// ============================================================================

function buildMessagesFromGroup(
  group: NarrativeEntry[],
  opts?: BuildMessagesOptions,
): ModelMessage[] {
  const allPlayer = group.every(isPlayerInputEntry);
  if (allPlayer) {
    return [buildUserMessage(group)];
  }
  return buildAssistantAndToolMessages(group, opts);
}

// ─── Player group → User message ────────────────────────────────────────────

function buildUserMessage(group: NarrativeEntry[]): UserModelMessage {
  // 本 MVP 下玩家一次提交预期只有 1 条 entry；留多 entry 兼容未来多模态
  // （但当前返回值仍是 string content —— 真要多模态时要走 UserContent[] 分支）。
  const text = group.map((e) => e.content).join('\n\n');
  return { role: 'user', content: text };
}

// ─── LLM step group → Assistant + Tool message ─────────────────────────────

function buildAssistantAndToolMessages(
  group: NarrativeEntry[],
  opts?: BuildMessagesOptions,
): ModelMessage[] {
  const wrap =
    opts?.wrapToolOutput ?? ((output: unknown) => ({ type: 'json' as const, value: output as any }));

  // 收集三类 content block 原料
  const narrativeText = group
    .filter(isNarrativeEntry)
    .map((e) => e.content)
    // narrative entries 原文里自带空白/换行；不额外 normalize，空串拼接即可
    .join('');

  const toolCallParts: ToolCallPart[] = [];
  const toolResultParts: ToolResultPart[] = [];

  for (const e of group) {
    if (isToolCallEntry(e)) {
      const toolName = e.content;
      // 用 entry.id 作 toolCallId 保证稳定且和 tool-result 配对
      toolCallParts.push({
        type: 'tool-call',
        toolCallId: e.id,
        toolName,
        input: e.payload.input,
      });
      toolResultParts.push({
        type: 'tool-result',
        toolCallId: e.id,
        toolName,
        output: wrap(e.payload.output),
      });
    } else if (isSignalInputEntry(e)) {
      // signal_input 作为 tool-call / tool-result 对也进消息链
      toolCallParts.push({
        type: 'tool-call',
        toolCallId: e.id,
        toolName: 'signal_input_needed',
        input: {
          prompt_hint: e.content,
          choices: readChoices(e),
        },
      });
      toolResultParts.push({
        type: 'tool-result',
        toolCallId: e.id,
        toolName: 'signal_input_needed',
        // 实际运行时 signal_input_needed.execute 挂起后返回的是 `{success:true, playerChoice:...}`
        // 或方案 B 下的 `{success:true}`。玩家选择本身由后续 player_input 的 user message 承担。
        // 视图层固定返回 `{success:true}` —— LLM 看到"tool 成功了，下面 user 消息给了答"即可理解。
        output: wrap({ success: true }),
      });
    }
    // narrative / player_input 不产生 tool block
  }

  // 组装 assistant message content
  const assistantContent: AssistantModelMessage['content'] =
    narrativeText.length > 0 && toolCallParts.length === 0
      ? narrativeText                                                  // 只有 text → 直接用 string
      : narrativeText.length > 0
        ? [{ type: 'text', text: narrativeText } as TextPart, ...toolCallParts]
        : toolCallParts.length > 0
          ? toolCallParts
          : '';                                                        // 空组兜底（理论不会到这里）

  const assistantMessage: AssistantModelMessage = {
    role: 'assistant',
    content: assistantContent,
  };

  const out: ModelMessage[] = [assistantMessage];
  if (toolResultParts.length > 0) {
    const toolMessage: ToolModelMessage = {
      role: 'tool',
      content: toolResultParts,
    };
    out.push(toolMessage);
  }
  return out;
}
