/**
 * LLM Client — AI SDK wrapper for agentic generation
 *
 * Wraps Vercel AI SDK's streamText with tool support.
 * Handles the agentic loop: text → tool_call → execute → continue → text.
 *
 * AI SDK v6 uses `stopWhen` + `stepCountIs` instead of `maxSteps`.
 */

import { streamText, stepCountIs, hasToolCall, tool, zodSchema, type ToolSet } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ToolHandler } from './tool-executor';
import type { ChatMessage } from './context-assembler';

// ============================================================================
// Types
// ============================================================================

export interface LLMConfig {
  provider: string;       // e.g. "openai-compatible"
  baseURL: string;        // e.g. "https://api.openai.com/v1"
  apiKey: string;
  model: string;          // e.g. "gpt-4o", "claude-sonnet-4-20250514"
  name?: string;          // provider display name
}

export interface GenerateOptions {
  systemPrompt: string;
  messages: ChatMessage[];
  tools: Record<string, ToolHandler>;
  maxSteps?: number;         // max tool call rounds (default: 10)
  maxOutputTokens?: number;   // max output tokens
  onTextChunk?: (text: string) => void;
  onReasoningChunk?: (text: string) => void;
  onToolCall?: (name: string, args: unknown) => void;
  onToolResult?: (name: string, result: unknown) => void;
}

export interface GenerateResult {
  text: string;               // full accumulated text
  toolCalls: Array<{ name: string; args: unknown; result: unknown }>;
  finishReason: string;
  inputSignaled: boolean;     // whether signal_input_needed was called
  inputHint?: string;         // prompt_hint from signal_input_needed
  inputChoices?: string[];    // choices from signal_input_needed
}

// ============================================================================
// Convert ToolHandlers to AI SDK ToolSet
// ============================================================================

/** 终止工具名单：这些工具不定义 execute，LLM 调用时 SDK 直接终止循环 */
const TERMINAL_TOOLS = new Set(['signal_input_needed']);

function buildAISDKTools(
  handlers: Record<string, ToolHandler>,
): ToolSet {
  const result: ToolSet = {};

  for (const [name, handler] of Object.entries(handlers)) {
    if (TERMINAL_TOOLS.has(name)) {
      // 终止工具：不提供 execute，SDK 收到调用后不执行、直接终止 agentic loop
      result[name] = tool({
        description: handler.description,
        inputSchema: zodSchema(handler.parameters),
      });
    } else {
      result[name] = tool({
        description: handler.description,
        inputSchema: zodSchema(handler.parameters),
        execute: async (args) => handler.execute(args),
      });
    }
  }

  return result;
}

// ============================================================================
// LLM Client
// ============================================================================

export class LLMClient {
  private config: LLMConfig;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  private getModel() {
    const provider = createOpenAICompatible({
      name: this.config.name ?? 'provider',
      baseURL: this.config.baseURL,
      apiKey: this.config.apiKey,
      // 关闭 DeepSeek 等模型的内置思考模式，避免 reasoning 混入正文
      transformRequestBody: (body) => ({
        ...body,
        enable_thinking: false,
      }),
    });
    return provider.chatModel(this.config.model);
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const {
      systemPrompt,
      messages,
      tools: toolHandlers,
      maxSteps = 10,
      maxOutputTokens,
      onTextChunk,
      onReasoningChunk,
      onToolCall: onToolCallCb,
      onToolResult: onToolResultCb,
    } = options;

    const aiTools = buildAISDKTools(toolHandlers);
    const toolCallLog: Array<{ name: string; args: unknown; result: unknown }> = [];

    // Build AI SDK messages
    const aiMessages: Array<{ role: 'user' | 'assistant'; content: string }> = messages.map((m) => ({
      role: m.role === 'system' ? 'user' as const : m.role as 'user' | 'assistant',
      content: m.content,
    }));

    const result = streamText({
      model: this.getModel(),
      system: systemPrompt,
      messages: aiMessages,
      tools: aiTools,
      // 终止条件：达到 maxSteps 或 LLM 调了终止工具
      stopWhen: [stepCountIs(maxSteps), hasToolCall('signal_input_needed')],
      maxOutputTokens,
      experimental_onToolCallStart: (event) => {
        const { toolName, input } = event.toolCall;
        onToolCallCb?.(toolName, input);
        toolCallLog.push({ name: toolName, args: input, result: undefined });
      },
      experimental_onToolCallFinish: (event) => {
        const { toolName } = event.toolCall;
        const output = event.success ? event.output : event.error;
        onToolResultCb?.(toolName, output);
        const logEntry = toolCallLog.find(
          (entry) => entry.name === toolName && entry.result === undefined,
        );
        if (logEntry) {
          logEntry.result = output;
        }
      },
    });

    // Stream via fullStream to separate reasoning from text
    let fullText = '';
    let fullReasoning = '';

    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        fullText += part.text;
        onTextChunk?.(part.text);
      } else if (part.type === 'reasoning-delta') {
        fullReasoning += part.text;
        onReasoningChunk?.(part.text);
      }
      // tool-call and tool-result are handled by experimental_onToolCall* callbacks
    }

    const finalResult = await result;
    const finishReason = await finalResult.finishReason;

    // 从 toolCallLog 中提取终止工具的参数（signal_input_needed 没有 execute，
    // 但 experimental_onToolCallStart 仍然会记录它的 args）
    const signalCall = toolCallLog.find((tc) => tc.name === 'signal_input_needed');
    const inputSignaled = !!signalCall;
    const signalArgs = signalCall?.args as { prompt_hint?: string; choices?: string[] } | undefined;

    return {
      text: fullText,
      toolCalls: toolCallLog,
      finishReason,
      inputSignaled,
      inputHint: signalArgs?.prompt_hint,
      inputChoices: signalArgs?.choices,
    };
  }

  updateConfig(config: Partial<LLMConfig>): void {
    Object.assign(this.config, config);
  }
}
