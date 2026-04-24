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

// 这些类型由 `ai` 从 @ai-sdk/provider-utils 重新导出 —— 直接从 provider-utils
// 导入会在 Docker build（pnpm 严格模式）下挂掉："Cannot find module '@ai-sdk/provider-utils'"，
// 因为它是 `ai` 的传递依赖，没列在我们的 package.json 里。Bun/node 的宽松解析器可以
// 走 hoisted layout 拿到，pnpm 不行。走 `ai` 这一层最稳。
import type {
  ModelMessage,
  AssistantModelMessage,
  ToolModelMessage,
  UserModelMessage,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from 'ai';

// ReasoningPart 由 @ai-sdk/provider-utils 定义，但 `ai` 没把它 re-export
// （只 re-export 了 ReasoningUIPart/ReasoningOutput）。直接 import
// '@ai-sdk/provider-utils' 会在 Docker pnpm 严格模式下炸（它是传递依赖，
// 没列在 package.json）。最便宜的办法：本地内联这个接口，AssistantContent
// 的 union 里接受这个 shape 即可。
interface ReasoningPart {
  type: 'reasoning';
  text: string;
}
import { estimateTokens } from '#internal/tokens';

import {
  isNarrativeEntry,
  isSignalInputEntry,
  isToolCallEntry,
  isPlayerInputEntry,
  readChoices,
  type NarrativeEntry,
} from '#internal/persistence-entry';

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

  // reasoner 模型（DeepSeek v4 thinking / deepseek-reasoner）的 thinking 痕迹。
  // DeepSeek thinking 模式强制要求：assistant message 有 tool_calls 时必须带
  // reasoning_content（否则 API 报 "The reasoning_content in the thinking mode
  // must be passed back"）。AI SDK 的 ReasoningPart 会被 openai-compatible
  // provider 序列化成 reasoning_content。
  //
  // 旧数据（2026-04-24 之前）narrative_entries.reasoning = null，回放时此处为
  // 空 → 不生成 ReasoningPart。DeepSeek v4 对那些老 assistant message 仍会
  // 报错。解决办法是起新 playthrough；或以后做 DB backfill 补默认占位符。
  const reasoningText = group
    .filter(isNarrativeEntry)
    .map((e) => e.reasoning ?? '')
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
  //
  // 结构化顺序（AI SDK 约定 & DeepSeek 兼容）：
  //   [ReasoningPart?, TextPart?, ToolCallPart...]
  //
  // reasoning 放最前面 —— provider 序列化时 reasoning_content 通常是 message 级
  // 元数据，位置不敏感；放首部只是视觉上符合"先思考再输出"的惯例。
  //
  // 简化形：只有纯文本、没有 reasoning 和 tool-call → 直接用 string 更紧凑
  //（provider cache / 日志显示都更友好）。
  const hasReasoning = reasoningText.length > 0;
  const hasText = narrativeText.length > 0;
  const hasTools = toolCallParts.length > 0;

  const reasoningPart: ReasoningPart | null = hasReasoning
    ? { type: 'reasoning', text: reasoningText }
    : null;
  const textPart: TextPart | null = hasText ? { type: 'text', text: narrativeText } : null;

  let assistantContent: AssistantModelMessage['content'];
  if (hasText && !hasTools && !hasReasoning) {
    assistantContent = narrativeText;   // 最常见情况用 string
  } else if (!hasText && !hasTools && !hasReasoning) {
    assistantContent = '';              // 空组兜底（理论不会到这里）
  } else {
    const parts: Array<ReasoningPart | TextPart | ToolCallPart> = [];
    if (reasoningPart) parts.push(reasoningPart);
    if (textPart) parts.push(textPart);
    parts.push(...toolCallParts);
    assistantContent = parts;
  }

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

// ============================================================================
// Budget cap + orphan-tool pruning
// ============================================================================

/**
 * 按 token 预算从**尾部**（最新）往前裁，保留最新 N 条。
 *
 * 为什么从尾部裁：LLM context 里最相关的是最新的历史 —— 如果 budget 不够，
 * 丢最早的、留最晚的最符合注意力预期（老代码从头裁是 bug，budget 紧时会丢
 * 最近发生的对话，in-context learning 失效）。
 *
 * 孤悬 tool 处理：`messages-builder` 保证 `[assistant(含 tool-call), tool(含
 * tool-result)]` 是连续的一对。从尾部裁时如果 cutoff 恰好在这对的中间（只
 * 留了 tool 没留它前面的 assistant），provider 会抛 `MissingToolResultsError`
 * —— 我们把孤悬的 tool message 往后挪一格剪掉，保证返回的 messages[0].role
 * 永远不是 'tool'。
 *
 * estimateTokens 走 JSON.stringify 的粗估：tool-call parts 里的 input JSON
 * 也算进预算。真实 token 数 provider 侧还会差一点，留 outputReserve buffer。
 */
export function capMessagesByBudgetFromTail(
  messages: ModelMessage[],
  budget: number,
): { messages: ModelMessage[]; tokensUsed: number } {
  if (messages.length === 0 || budget <= 0) {
    return { messages: [], tokensUsed: 0 };
  }

  // 预算粗估：每条 message 序列化后算一次；可以被 assertion test 复算
  const msgTokens = messages.map((m) => estimateTokensForMessage(m));

  let used = 0;
  let startIdx = messages.length; // exclusive；最终保留 messages[startIdx..]
  for (let i = messages.length - 1; i >= 0; i--) {
    const cost = msgTokens[i]!;
    if (used + cost > budget) break;
    used += cost;
    startIdx = i;
  }

  // 孤悬 tool：如果切出来的头是 role='tool'，它对应的 assistant 没被留住 ——
  // 往后挪 cutoff 跳过这个孤 tool（兜底；budget 正常的话走不到这里）
  while (startIdx < messages.length && messages[startIdx]!.role === 'tool') {
    used -= msgTokens[startIdx]!;
    startIdx++;
  }

  return { messages: messages.slice(startIdx), tokensUsed: used };
}

/**
 * 估算一条 ModelMessage 的 token 成本。
 *
 * 选择走 `JSON.stringify` 是因为 ModelMessage 的 content 可能是 string，
 * 也可能是 `[TextPart, ToolCallPart, ...]` 或 `[ToolResultPart, ...]` —— 统一
 * 序列化后再 estimateTokens 比逐 part 累加简单可靠；tool-call 的 input JSON
 * 也被自然算进去。
 */
function estimateTokensForMessage(msg: ModelMessage): number {
  if (typeof msg.content === 'string') {
    return estimateTokens(msg.content);
  }
  // content 是 ContentPart[]
  return estimateTokens(JSON.stringify(msg.content));
}

// ============================================================================
// Debug serialization —— flatten ModelMessage → {role, content: string}
// ============================================================================

/**
 * 把 ModelMessage[] 拍平成 `{role, content: string}[]`，给 UI 调试面板 /
 * tracing 用。tool-call parts 序列化成可读 JSON，tool-result parts 一样。
 *
 * 目的：让 EditorDebugPanel 这种"只会渲染 string content"的消费者不用改，
 * 同时保留 tool history 的可见性（展开 JSON 一眼能看到 change_scene 传了啥）。
 */
export function serializeMessagesForDebug(
  messages: ModelMessage[],
): Array<{ role: string; content: string }> {
  return messages.map((m) => ({
    role: m.role,
    content: serializeContent(m.content),
  }));
}

function serializeContent(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  // ContentPart[] —— 逐 part 按可读性重组
  const lines: string[] = [];
  for (const part of content) {
    if ((part as { type: string }).type === 'text') {
      lines.push((part as { text: string }).text);
    } else {
      // tool-call / tool-result / 其它：整 part JSON 序列化，开头标 type 方便扫
      const p = part as { type: string };
      lines.push(`[${p.type}] ${JSON.stringify(part)}`);
    }
  }
  return lines.join('\n');
}
