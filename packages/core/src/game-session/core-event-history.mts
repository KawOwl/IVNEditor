import type {
  AssistantModelMessage,
  ModelMessage,
  TextPart,
  ToolCallPart,
  ToolModelMessage,
  ToolResultPart,
  UserModelMessage,
  JSONValue,
} from 'ai';

import type {
  CoreEvent,
  CoreEventEnvelope,
} from '#internal/game-session/core-events';
import { estimateTokens } from '#internal/tokens';
import type { MemoryEntry, SceneState, Sentence } from '#internal/types';

interface ReasoningPart {
  type: 'reasoning';
  text: string;
}

type MessageToolCall = {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly output: unknown;
};

type AssistantGroup = {
  readonly kind: 'assistant';
  readonly key: string;
  narrativeText: string;
  reasoningText: string;
  toolCalls: MessageToolCall[];
};

type UserGroup = {
  readonly kind: 'user';
  readonly text: string;
};

type MessageGroup = AssistantGroup | UserGroup;

export interface CoreEventHistoryItem {
  readonly sequence: number;
  readonly occurredAt: number;
  readonly event: CoreEvent;
}

export interface CoreEventHistoryReader {
  readRecent(opts: { readonly limit: number }): Promise<CoreEventHistoryItem[]>;
  readRange(opts: {
    readonly fromSequence?: number;
    readonly toSequence?: number;
  }): Promise<CoreEventHistoryItem[]>;
}

export interface CoreEventSentencePage {
  readonly sentences: readonly Sentence[];
  readonly offset: number;
  readonly limit: number;
  readonly totalEntries: number;
  readonly hasMore: boolean;
  readonly nextOffset: number;
}

export interface CoreEventMemoryEntry extends MemoryEntry {
  readonly sequence: number;
}

export interface BuildCoreEventMessagesOptions {
  readonly wrapToolOutput?: (output: unknown) => { type: 'json'; value: JSONValue };
}

export function coreEventHistoryFromEnvelopes(
  envelopes: readonly CoreEventEnvelope[],
  options: { readonly sortBySequence?: boolean } = {},
): CoreEventHistoryItem[] {
  const ordered = options.sortBySequence
    ? [...envelopes].sort((a, b) => a.sequence - b.sequence)
    : envelopes;

  return ordered.map((envelope) => {
    if (envelope.schemaVersion !== 1) {
      throw new Error(`Unsupported CoreEvent envelope schemaVersion: ${envelope.schemaVersion}`);
    }
    return {
      sequence: envelope.sequence,
      occurredAt: envelope.occurredAt,
      event: structuredClone(envelope.event),
    };
  });
}

export function projectCoreEventHistoryToSentences(
  history: readonly CoreEventHistoryItem[],
): Sentence[] {
  return sortHistory(history).flatMap(({ event }) => {
    switch (event.type) {
      case 'narrative-batch-emitted':
        return event.sentences.map(copySentence);
      case 'scene-changed':
        return [copySentence(event.sentence)];
      case 'signal-input-recorded':
        return [copySentence(event.sentence)];
      case 'player-input-recorded':
        return [copySentence(event.sentence)];
      default:
        return [];
    }
  });
}

export function projectCoreEventHistoryPage(
  history: readonly CoreEventHistoryItem[],
  options: { readonly offset: number; readonly limit: number },
): CoreEventSentencePage {
  const offset = Math.max(0, options.offset);
  const limit = Math.max(0, options.limit);
  const sentences = projectCoreEventHistoryToSentences(history);
  const pageSentences = sentences.slice(offset, offset + limit);
  const nextOffset = offset + pageSentences.length;
  return {
    sentences: pageSentences,
    offset,
    limit,
    totalEntries: sentences.length,
    hasMore: nextOffset < sentences.length,
    nextOffset,
  };
}

export function projectCoreEventHistoryToMemoryEntries(
  history: readonly CoreEventHistoryItem[],
): CoreEventMemoryEntry[] {
  const sorted = sortHistory(history);
  // 改进 B（2026-04-26）：跟 buildMessagesFromCoreEventHistory 一样，被
  // rewrite 替换过的 turn 只用 'rewrite-applied' 那条 segment 作为权威；
  // 同 turn 内其他 reason（preflush / generate-complete）被废弃，不进 memory。
  const rewriteAppliedTurns = new Set<string>();
  for (const item of sorted) {
    if (
      item.event.type === 'narrative-segment-finalized' &&
      item.event.reason === 'rewrite-applied'
    ) {
      rewriteAppliedTurns.add(item.event.turnId as unknown as string);
    }
  }

  return sorted.flatMap((item): CoreEventMemoryEntry[] => {
    const { event, occurredAt, sequence } = item;
    if (event.type === 'narrative-segment-finalized' && event.entry.content) {
      // 改进 B（修复版）：跟 buildMessagesFromCoreEventHistory 同款过滤逻辑
      // —— rewrite 替换的 turn 只跳过 preflush + generate-complete 这两类
      // 内容性 segment；step-reasoning 段 content='' 被上面 truthy check
      // 过滤，无需在此白名单。
      if (
        rewriteAppliedTurns.has(event.turnId as unknown as string) &&
        (event.reason === 'signal-input-preflush' ||
          event.reason === 'generate-complete')
      ) {
        return [];
      }
      return [{
        id: `core-event-${sequence}`,
        sequence,
        turn: readTurnNumber(event.turnId),
        role: 'generate',
        content: event.entry.content,
        tokenCount: estimateTokens(event.entry.content),
        timestamp: occurredAt,
        pinned: false,
      }];
    }

    if (event.type === 'player-input-recorded') {
      return [{
        id: `core-event-${sequence}`,
        sequence,
        turn: readTurnNumber(event.turnId),
        role: 'receive',
        content: event.text,
        tokenCount: estimateTokens(event.text),
        timestamp: occurredAt,
        pinned: false,
      }];
    }

    return [];
  });
}

export function buildMessagesFromCoreEventHistory(
  history: readonly CoreEventHistoryItem[],
  opts?: BuildCoreEventMessagesOptions,
): ModelMessage[] {
  const groups = groupCoreEventsForMessages(sortHistory(history));
  return groups.flatMap((group) =>
    group.kind === 'user'
      ? [buildUserMessage(group)]
      : buildAssistantAndToolMessages(group, opts),
  );
}

export function capMessagesByBudgetFromTail(
  messages: ModelMessage[],
  budget: number,
): { messages: ModelMessage[]; tokensUsed: number } {
  if (messages.length === 0 || budget <= 0) {
    return { messages: [], tokensUsed: 0 };
  }

  const msgTokens = messages.map((m) => estimateTokensForMessage(m));
  let used = 0;
  let startIdx = messages.length;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const cost = msgTokens[i]!;
    if (used + cost > budget) break;
    used += cost;
    startIdx = i;
  }

  while (startIdx < messages.length && messages[startIdx]!.role === 'tool') {
    used -= msgTokens[startIdx]!;
    startIdx += 1;
  }

  return { messages: messages.slice(startIdx), tokensUsed: used };
}

export function serializeMessagesForDebug(
  messages: ModelMessage[],
): Array<{ role: string; content: string }> {
  return messages.map((message) => ({
    role: message.role,
    content: serializeContent(message.content),
  }));
}

function groupCoreEventsForMessages(
  history: readonly CoreEventHistoryItem[],
): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let active: AssistantGroup | null = null;

  // 改进 B（2026-04-26）：第一遍扫出哪些 turn 被 rewrite 替换过。
  // 这些 turn 内**只跳过内容性 segment**（'signal-input-preflush' /
  // 'generate-complete'）—— 这俩 reason 落的 content 已经被 'rewrite-applied'
  // 整 turn 重写覆盖，进 history 会污染下一轮 in-context。
  //
  // **必须保留 'step-reasoning' segment**（DeepSeek V4 thinking 模式硬要求）：
  // 每个 step 的 reasoning 单独落一条 step-reasoning segment（content=''，
  // reasoning=该 step 的 thinking 内容）；DeepSeek API 要求所有带 tool_calls
  // 的 assistant message 必带 reasoning_content，否则 400 报错
  // "The reasoning_content in the thinking mode must be passed back to the API."
  // 第一版改进 B 错误地按 reason !== 'rewrite-applied' 过滤，把 step-reasoning
  // 也跳了 → trace cc5a92fe（turn 3）报错；本次修复改成显式列出要跳的两个 reason。
  const SKIPPED_REASONS_WHEN_REWRITE_APPLIED: ReadonlySet<string> = new Set([
    'signal-input-preflush',
    'generate-complete',
  ]);
  const rewriteAppliedTurns = new Set<string>();
  for (const item of history) {
    if (
      item.event.type === 'narrative-segment-finalized' &&
      item.event.reason === 'rewrite-applied'
    ) {
      rewriteAppliedTurns.add(item.event.turnId as unknown as string);
    }
  }

  const flush = () => {
    if (!active) return;
    groups.push(active);
    active = null;
  };

  const ensureAssistant = (key: string): AssistantGroup => {
    if (active?.key === key) return active;
    flush();
    active = {
      kind: 'assistant',
      key,
      narrativeText: '',
      reasoningText: '',
      toolCalls: [],
    };
    return active;
  };

  for (const item of history) {
    const { event, sequence } = item;
    switch (event.type) {
      case 'narrative-segment-finalized': {
        // 改进 B（修复版）：rewrite 替换过的 turn 仅跳过**内容性** segment
        // （preflush + generate-complete），保留 step-reasoning 给 DeepSeek
        // V4 thinking 模式提供 reasoning_content。
        if (
          rewriteAppliedTurns.has(event.turnId as unknown as string) &&
          SKIPPED_REASONS_WHEN_REWRITE_APPLIED.has(event.reason)
        ) {
          break;
        }
        const group = ensureAssistant(messageGroupKey(event.batchId, sequence));
        group.narrativeText += event.entry.content;
        group.reasoningText += event.entry.reasoning ?? '';
        break;
      }

      case 'tool-call-finished': {
        if (!event.batchId) break;
        if (event.toolName === 'signal_input_needed' || event.toolName === 'end_scenario') {
          break;
        }
        const group = ensureAssistant(messageGroupKey(event.batchId, sequence));
        group.toolCalls.push({
          toolCallId: `core-event-${sequence}`,
          toolName: event.toolName,
          input: structuredClone(event.input),
          output: structuredClone(event.output),
        });
        break;
      }

      case 'signal-input-recorded': {
        const group = ensureAssistant(messageGroupKey(event.batchId, sequence));
        group.toolCalls.push({
          toolCallId: `core-event-${sequence}`,
          toolName: 'signal_input_needed',
          input: { prompt_hint: event.request.hint ?? '' },
          output: { success: true },
        });
        break;
      }

      case 'player-input-recorded':
        flush();
        groups.push({ kind: 'user', text: event.text });
        break;

      default:
        break;
    }
  }

  flush();
  return groups;
}

function buildUserMessage(group: UserGroup): UserModelMessage {
  return { role: 'user', content: group.text };
}

function buildAssistantAndToolMessages(
  group: AssistantGroup,
  opts?: BuildCoreEventMessagesOptions,
): ModelMessage[] {
  const wrap =
    opts?.wrapToolOutput ?? ((output: unknown) => ({ type: 'json' as const, value: toJsonValue(output) }));
  const toolCallParts: ToolCallPart[] = group.toolCalls.map((call) => ({
    type: 'tool-call',
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
  }));
  const toolResultParts: ToolResultPart[] = group.toolCalls.map((call) => ({
    type: 'tool-result',
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    output: wrap(call.output),
  }));

  const hasReasoning = group.reasoningText.length > 0;
  const hasText = group.narrativeText.length > 0;
  const hasTools = toolCallParts.length > 0;
  const reasoningPart: ReasoningPart | null = hasReasoning
    ? { type: 'reasoning', text: group.reasoningText }
    : null;
  const textPart: TextPart | null = hasText
    ? { type: 'text', text: group.narrativeText }
    : null;

  let assistantContent: AssistantModelMessage['content'];
  if (hasText && !hasTools && !hasReasoning) {
    assistantContent = group.narrativeText;
  } else if (!hasText && !hasTools && !hasReasoning) {
    assistantContent = '';
  } else {
    const parts: Array<ReasoningPart | TextPart | ToolCallPart> = [];
    if (reasoningPart) parts.push(reasoningPart);
    if (textPart) parts.push(textPart);
    parts.push(...toolCallParts);
    assistantContent = parts;
  }

  const out: ModelMessage[] = [{ role: 'assistant', content: assistantContent }];
  if (toolResultParts.length > 0) {
    const toolMessage: ToolModelMessage = {
      role: 'tool',
      content: toolResultParts,
    };
    out.push(toolMessage);
  }
  return out;
}

function messageGroupKey(batchId: string | null, sequence: number): string {
  return batchId ?? `core-event-${sequence}`;
}

function sortHistory(history: readonly CoreEventHistoryItem[]): CoreEventHistoryItem[] {
  return [...history].sort((a, b) => a.sequence - b.sequence);
}

function readTurnNumber(turnId: string): number {
  const match = /^turn-(\d+)/.exec(turnId);
  return match ? Number(match[1]) : 0;
}

function estimateTokensForMessage(message: ModelMessage): number {
  if (typeof message.content === 'string') {
    return estimateTokens(message.content);
  }
  return estimateTokens(JSON.stringify(message.content));
}

function serializeContent(content: ModelMessage['content']): string {
  if (typeof content === 'string') return content;
  return content.map((part) => {
    if ((part as { type: string }).type === 'text') {
      return (part as { text: string }).text;
    }
    const typed = part as { type: string };
    return `[${typed.type}] ${JSON.stringify(part)}`;
  }).join('\n');
}

function toJsonValue(value: unknown): JSONValue {
  if (value === null) return null;

  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
    case 'symbol':
    case 'function':
    case 'undefined':
      return String(value);
    case 'object':
      if (Array.isArray(value)) {
        return value.map(toJsonValue);
      }
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .map(([key, item]) => [key, toJsonValue(item)]),
      );
  }
  return null;
}

function copySentence(sentence: Sentence): Sentence {
  if (sentence.kind === 'narration') {
    return { ...sentence, sceneRef: copyScene(sentence.sceneRef) };
  }

  if (sentence.kind === 'dialogue') {
    return {
      ...sentence,
      pf: {
        speaker: sentence.pf.speaker,
        ...(sentence.pf.addressee ? { addressee: [...sentence.pf.addressee] } : {}),
        ...(sentence.pf.overhearers ? { overhearers: [...sentence.pf.overhearers] } : {}),
        ...(sentence.pf.eavesdroppers ? { eavesdroppers: [...sentence.pf.eavesdroppers] } : {}),
      },
      sceneRef: copyScene(sentence.sceneRef),
    };
  }

  if (sentence.kind === 'scene_change') {
    return { ...sentence, scene: copyScene(sentence.scene) };
  }

  return { ...sentence, sceneRef: copyScene(sentence.sceneRef) };
}

function copyScene(scene: SceneState): SceneState {
  return {
    background: scene.background,
    sprites: scene.sprites.map((sprite) => ({ ...sprite })),
  };
}
