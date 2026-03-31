/**
 * LLM Client — AI SDK wrapper for agentic generation
 *
 * Wraps Vercel AI SDK's streamText with tool support.
 * Handles the agentic loop: text → tool_call → execute → continue → text.
 *
 * AI SDK v6 uses `stopWhen` + `stepCountIs` instead of `maxSteps`.
 */

import { streamText, stepCountIs, tool, zodSchema, type ToolSet } from 'ai';
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
}

// ============================================================================
// Convert ToolHandlers to AI SDK ToolSet
// ============================================================================

function buildAISDKTools(
  handlers: Record<string, ToolHandler>,
): ToolSet {
  const result: ToolSet = {};

  for (const [name, handler] of Object.entries(handlers)) {
    // AI SDK v6: `parameters` → `inputSchema`
    // Zod v4: must wrap with `zodSchema()` for correct JSON Schema conversion
    result[name] = tool({
      description: handler.description,
      inputSchema: zodSchema(handler.parameters),
      execute: async (args) => handler.execute(args),
    });
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

    // Track signal_input_needed
    let inputSignaled = false;
    let inputHint: string | undefined;

    // Wrap signal_input_needed to capture the signal
    const wrappedHandlers = { ...toolHandlers };
    const originalSignal = wrappedHandlers['signal_input_needed'];
    if (originalSignal) {
      wrappedHandlers['signal_input_needed'] = {
        ...originalSignal,
        execute: (args) => {
          inputSignaled = true;
          const typedArgs = args as { prompt_hint?: string };
          inputHint = typedArgs.prompt_hint;
          return originalSignal.execute(args);
        },
      };
    }

    const aiTools = buildAISDKTools(wrappedHandlers);
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
      stopWhen: stepCountIs(maxSteps),
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

    return {
      text: fullText,
      toolCalls: toolCallLog,
      finishReason: await finalResult.finishReason,
      inputSignaled,
      inputHint,
    };
  }

  updateConfig(config: Partial<LLMConfig>): void {
    Object.assign(this.config, config);
  }
}
