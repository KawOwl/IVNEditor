/**
 * LLM Client — AI SDK wrapper for agentic generation
 *
 * Wraps Vercel AI SDK's streamText with tool support.
 * Handles the agentic loop: text → tool_call → execute → continue → text.
 *
 * signal_input_needed 使用挂起模式：execute 返回 Promise，等玩家输入后 resolve，
 * LLM 拿到 tool result 后自然继续生成。不需要 hasToolCall 终止。
 */

import { streamText, stepCountIs, tool, zodSchema, type ToolSet } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
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
  thinkingEnabled?: boolean;  // 启用模型内置思考模式
  reasoningFilterEnabled?: boolean;  // 启用启发式推理过滤器（无原生思考时）
}

/**
 * 单步信息（AI SDK 每次 LLM API 调用对应一个 step）
 * 用于 onStep 回调 —— 一个 agentic loop 内会有多个 step
 */
export interface StepInfo {
  stepNumber: number;
  text: string;
  reasoning?: string;
  finishReason: string;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls: Array<{ name: string; args: unknown }>;
  model?: string;
  /**
   * 此 step 中 LLM 输出 content 里存在的 part 类型集合（去重）。
   * 例如 ['text', 'tool-call'] 表示既有叙事文本又有工具调用；
   * 只有 ['tool-call'] 则表示纯工具步。
   * 这是模型协议层面的结构信号，比字数判断更可靠。
   */
  partKinds: string[];
  /**
   * AI SDK 汇报的 `step.response.timestamp` —— 表示 LLM 响应**开始**
   * 的时间点，在 provider 开始 stream 时就被赋值，不受该 step 内的
   * tool 执行/挂起影响。
   *
   * 用处：tracing 层用这个作为 generation span 的时间戳，避免出现
   * "step 带 signal_input_needed 时，onStep 被 tool 挂起延后触发，导致
   * 记录到的时间是玩家回复之后"的错位问题（见 Langfuse trace 调查）。
   *
   * 某些 provider 不发 response-metadata chunk 时，AI SDK 会 fallback 到
   * streamStep 入口处的 `new Date()`，仍然是"step 开始"而非"step 结束"，
   * 所以这个字段始终可用。
   */
  responseTimestamp?: Date;
}

export interface GenerateOptions {
  systemPrompt: string;
  messages: ChatMessage[];
  tools: Record<string, ToolHandler>;
  maxSteps?: number;         // max agentic steps (default: 30)
  maxOutputTokens?: number;   // max output tokens
  abortSignal?: AbortSignal;  // 用于外部中断（停止/重置）
  onTextChunk?: (text: string) => void;
  onReasoningChunk?: (text: string) => void;
  onToolCall?: (name: string, args: unknown) => void;
  onToolResult?: (name: string, result: unknown) => void;
  /** 每个 step（内部 LLM API 调用）结束时触发，用于追踪/观测 */
  onStep?: (step: StepInfo) => void;
}

export interface GenerateResult {
  text: string;               // full accumulated text
  toolCalls: Array<{ name: string; args: unknown; result: unknown }>;
  finishReason: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
}

// ============================================================================
// Convert ToolHandlers to AI SDK ToolSet
// ============================================================================

/**
 * 构建 AI SDK ToolSet。所有工具都有 execute。
 * signal_input_needed 的 execute 会挂起等玩家输入（由 tool-executor 实现）。
 */
function buildAISDKTools(
  handlers: Record<string, ToolHandler>,
): ToolSet {
  const result: ToolSet = {};

  for (const [name, handler] of Object.entries(handlers)) {
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
    // Anthropic 原生协议（避开 OpenAI compat 代理重写工具名的问题）
    if (this.config.provider === 'anthropic') {
      const provider = createAnthropic({
        baseURL: this.config.baseURL,
        apiKey: this.config.apiKey,
        // 浏览器中调用需要明确同意（实际请求经由我们的服务器/编辑器试玩在浏览器执行）
        headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
      });
      return provider(this.config.model);
    }

    // OpenAI compatible（DeepSeek 等）
    const provider = createOpenAICompatible({
      name: this.config.name ?? 'provider',
      baseURL: this.config.baseURL,
      apiKey: this.config.apiKey,
      // 控制 DeepSeek 等模型的内置思考模式
      transformRequestBody: (body) => ({
        ...body,
        enable_thinking: this.config.thinkingEnabled ?? false,
      }),
    });
    return provider.chatModel(this.config.model);
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const {
      systemPrompt,
      messages,
      tools: toolHandlers,
      maxSteps = 30,
      maxOutputTokens,
      abortSignal,
      onTextChunk,
      onReasoningChunk,
      onToolCall: onToolCallCb,
      onToolResult: onToolResultCb,
      onStep,
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
      stopWhen: [stepCountIs(maxSteps)],
      maxOutputTokens,
      abortSignal,
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
      onStepFinish: (step) => {
        if (!onStep) return;
        try {
          const partKinds = Array.from(
            new Set(((step.content ?? []) as Array<{ type: string }>).map((p) => p.type)),
          );
          onStep({
            stepNumber: step.stepNumber,
            text: step.text,
            reasoning: step.reasoningText,
            finishReason: String(step.finishReason),
            inputTokens: step.usage?.inputTokens,
            outputTokens: step.usage?.outputTokens,
            toolCalls: step.toolCalls.map((tc) => ({
              name: tc.toolName,
              args: tc.input,
            })),
            model: step.model?.modelId,
            partKinds,
            // AI SDK 把 LLM response 开始的时间记在 step.response.timestamp，
            // 不受 tool 挂起污染。传给 tracing 层作为时间戳正源。
            responseTimestamp: step.response?.timestamp,
          });
        } catch (err) {
          console.error('[llm-client] onStep handler threw:', err);
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

    // 提取 token usage（Vercel AI SDK v6 提供 usage Promise/object）
    let usage: GenerateResult['usage'] | undefined;
    try {
      const u = await finalResult.usage;
      if (u) {
        usage = {
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          totalTokens: u.totalTokens,
        };
      }
    } catch {
      // 某些 provider 不返回 usage，静默忽略
    }

    return {
      text: fullText,
      toolCalls: toolCallLog,
      finishReason,
      usage,
    };
  }

  /** 当前模型名（用于 tracing/debug） */
  getModelName(): string {
    return this.config.model;
  }

  /** 当前配置是否启用了原生思考模式 */
  isThinkingEnabled(): boolean {
    return this.config.thinkingEnabled ?? false;
  }

  /** 当前配置是否启用了启发式推理过滤器 */
  isReasoningFilterEnabled(): boolean {
    return this.config.reasoningFilterEnabled ?? true;
  }

  updateConfig(config: Partial<LLMConfig>): void {
    Object.assign(this.config, config);
  }
}
