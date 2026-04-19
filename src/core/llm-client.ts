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
  maxOutputTokens?: number;  // 默认 max output tokens（DB llm_configs 表配置）
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
  /**
   * 该 step 发给 LLM 的**完整 messages 数组**的简化版。
   *
   * 来源：`experimental_onStepStart` 回调里的 `event.messages`，
   * 那是 AI SDK 为该 step 构造的完整对话历史（初始 messages +
   * 所有前序 step 的 assistant output + tool results）。
   *
   * 用途：tracing 层写进 Langfuse 每个 step generation 的 `input`，
   * 让你在 Langfuse UI 里点开每个 step 就能看到 LLM 实际看到的
   * 完整上下文——不再只看到初始的 "开始游戏" 一条。
   *
   * 简化规则：每条 message 只保留 `role` + `content`（前 500 字）。
   * 目的是降低传输和存储体积，同时保留足够的诊断信息。
   */
  stepInputMessages?: Array<{ role: string; content: string }>;
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

    // OpenAI compatible（DeepSeek / GPT 等）
    // 注：模型是否产生原生 reasoning 由模型本身决定（如 deepseek-reasoner 走
    // AI SDK reasoning-delta 流事件；deepseek-chat 不产生 reasoning）。引擎
    // 统一通过 onReasoningChunk 回调处理，不再做 enable_thinking 之类的
    // 请求参数注入。
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
      maxSteps = 30,
      maxOutputTokens = this.config.maxOutputTokens,
      abortSignal,
      onTextChunk,
      onReasoningChunk,
      onToolCall: onToolCallCb,
      onToolResult: onToolResultCb,
      onStep,
    } = options;

    const aiTools = buildAISDKTools(toolHandlers);
    const toolCallLog: Array<{ name: string; args: unknown; result: unknown }> = [];

    // Per-step input messages 捕获器。experimental_onStepStart 在每个 step
    // 发给 provider 之前触发，提供该 step 实际看到的完整 messages 数组。
    // 存进 Map，在 onStepFinish 时读出来传给 tracing。
    const stepInputsMap = new Map<number, Array<{ role: string; content: string }>>();

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
      // 捕获每个 step 的完整 input messages（含前序 step 的 tool results）
      experimental_onStepStart: (event) => {
        try {
          const simplified = (event.messages ?? []).map((m) => {
            const role = String(m.role);
            let content: string;
            if (typeof m.content === 'string') {
              content = m.content;
            } else if (Array.isArray(m.content)) {
              // 复合 content（tool calls、tool results、text parts 等）→ 简化
              content = (m.content as Array<{ type: string; text?: string; toolName?: string; result?: unknown }>)
                .map((part) => {
                  if (part.type === 'text') return String(part.text ?? '');
                  if (part.type === 'tool-call') return `[tool_call: ${part.toolName}]`;
                  if (part.type === 'tool-result') return `[tool_result: ${part.toolName} → ${String(part.result ?? '').slice(0, 200)}]`;
                  return `[${part.type}]`;
                })
                .join(' ');
            } else {
              content = JSON.stringify(m.content).slice(0, 300);
            }
            // 截断过长的 content，保持 trace 体积可控
            if (content.length > 500) content = content.slice(0, 500) + '…';
            return { role, content };
          });
          stepInputsMap.set(event.stepNumber, simplified);
        } catch {
          // 不影响主流程
        }
      },
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
            // 该 step 实际看到的完整 messages（从 onStepStart 捕获）
            stepInputMessages: stepInputsMap.get(step.stepNumber),
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

  updateConfig(config: Partial<LLMConfig>): void {
    Object.assign(this.config, config);
  }
}
