/**
 * LLM Client — AI SDK wrapper for agentic generation
 *
 * Wraps Vercel AI SDK's streamText with tool support.
 * Handles the agentic loop: text → tool_call → execute → continue → text.
 *
 * Turn-bounded 模式（方案 B，2026-04-23 起）：
 *   - 每次 generate() 对应**一个玩家回合**
 *   - stopWhen 同时拦截 maxSteps / signal_input_needed / end_scenario 三种情况
 *   - signal_input_needed 的 execute 改为 record-only，下一 step 前 stopWhen 触发
 *     让 generate() 干净返回；玩家输入通过下一次 generate() 的 user message 进入
 *   - 删除了老的"挂起模式"分支（createWaitForPlayerInput 等）
 *
 * 详见 .claude/plans/turn-bounded-generate.md 和 .claude/plans/messages-model.md。
 */

import { streamText, stepCountIs, hasToolCall, tool, zodSchema, type ToolSet } from 'ai';
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
   * 用处：tracing 层把它作为 generation span 的 endTime（time-to-first-token），
   * 和 stepStartAt 配对得到 TTFT 这段耗时。不用 onStepFinish 时刻避免被
   * 同 step 内的 signal_input_needed 挂起污染。
   *
   * 某些 provider 不发 response-metadata chunk 时，AI SDK 会 fallback 到
   * streamStep 入口处的 `new Date()`，仍然是"step 开始"而非"step 结束"，
   * 所以这个字段始终可用。
   */
  responseTimestamp?: Date;
  /**
   * 本 step 发送到 provider 之前的瞬间（experimental_onStepStart 回调时刻）。
   * tracing 层用作 generation span 的 startTime，配合 responseTimestamp
   * 得到 TTFT。避免以前所有 step 的 startTime 都用同一个 responseTimestamp
   * 导致时间轴错乱、duration=0 的问题。
   */
  stepStartAt?: Date;
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
  /**
   * 该 step 实际发给 LLM 的 system prompt。
   *
   * 如果 prepareStepSystem 在本 step 返回了覆盖字符串 → 这里是那个字符串；
   * 否则 → 是外层传入 streamText 的 systemPrompt 初值。
   *
   * 用途：tracing 层记录"**LLM 在本 step 真正看到的 system**"。
   * 没这个字段前，Focus Injection D 方案的 per-step system 切换在 Langfuse
   * 里完全不可观察（input.system 永远显示开局快照）。
   */
  effectiveSystemPrompt?: string;
  /**
   * 本 step 的 batchId（migration 0011）。
   * 在 experimental_onStepStart 里生成 UUID，该 step 的所有工具调用 + narrative
   * 写入 narrative_entries 时共享这个 id。
   *
   * 视图层 messages-builder 用 batchId 精确分组"一个 LLM step 的所有事件"，
   * 投影成一对 assistant + tool message。
   */
  batchId?: string;
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
  /**
   * 每个工具调用 finish 时触发（experimental_onToolCallFinish）—— 方案 B
   * 前置：把 tool_call 写入 narrative_entries.kind='tool_call'。
   *
   * **跳过 signal_input_needed / end_scenario**：
   *   - signal_input_needed 走专属的 onSignalInputRecorded 路径（hint + choices 写进 signal_input kind）
   *   - end_scenario 走 onScenarioFinished 路径
   *
   * 非目标：把 tool output 做任何业务转换 —— 只是原始 input/output 透传给上游做持久化。
   */
  onToolObserved?: (evt: {
    batchId: string;
    toolName: string;
    input: unknown;
    output: unknown;
    success: boolean;
  }) => void | Promise<void>;
  /**
   * Per-step system prompt 覆盖钩子（Focus Injection D 方案）。
   *
   * 每个 step 发送给 provider **之前**触发。返回 string → 覆盖本 step 的 system；
   * 返回 undefined → 沿用 streamText 外层传入的 systemPrompt。
   *
   * 用途：game-session 在这里读当前 state_vars，探测 focus (current_scene 等) 是否
   * 变了。没变则返回 undefined（外层 prompt 不动，provider 侧命中 prompt cache）；
   * 变了则调 assembleContext 重算 prompt 返回。
   *
   * stepNumber=0 通常返回 undefined（外层已经算过初始 prompt 了）。
   */
  prepareStepSystem?: (info: {
    stepNumber: number;
    steps: ReadonlyArray<unknown>;  // 已完成 step 的只读数组
  }) => Promise<string | undefined> | string | undefined;
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
      // turn-bounded 模式下每回合预算：典型 3-5 步，留 4x 余量
      maxSteps = 20,
      maxOutputTokens = this.config.maxOutputTokens,
      abortSignal,
      onTextChunk,
      onReasoningChunk,
      onToolCall: onToolCallCb,
      onToolResult: onToolResultCb,
      onStep,
      onToolObserved,
      prepareStepSystem,
    } = options;

    const aiTools = buildAISDKTools(toolHandlers);
    const toolCallLog: Array<{ name: string; args: unknown; result: unknown }> = [];

    // Per-step input messages 捕获器。experimental_onStepStart 在每个 step
    // 发给 provider 之前触发，提供该 step 实际看到的完整 messages 数组。
    // 存进 Map，在 onStepFinish 时读出来传给 tracing。
    const stepInputsMap = new Map<number, Array<{ role: string; content: string }>>();
    // 该 step 的真实"开始发往 provider"瞬间。配合 responseTimestamp 得到 TTFT。
    const stepStartAtMap = new Map<number, Date>();
    // 该 step 实际发往 provider 的 system prompt。prepareStep 返回的覆盖值会被记进来；
    // 返回 undefined 或未提供 prepareStepSystem 时，记为外层的 systemPrompt。
    // tracing 层读这个以反映 Focus Injection D 的 per-step 切换。
    const stepSystemMap = new Map<number, string>();
    // 该 step 的 batchId（migration 0011）—— experimental_onStepStart 生成，
    // experimental_onToolCallFinish 和 onStepFinish 用来 tag entries。
    const stepBatchIdMap = new Map<number, string>();
    // 当前正在执行的 step 编号（experimental_onToolCallFinish 拿 batchId 用）。
    // AI SDK 在一个 step 内按顺序触发 start → tool_calls → finish，所以这个
    // 值在 tool 回调里都是当前 step 的 stepNumber。
    let currentStepNumber = 0;

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
      // 方案 B：三种停止条件
      //   - stepCountIs(maxSteps)：每回合 step 预算上限（默认 20）
      //   - hasToolCall('signal_input_needed')：LLM 请求玩家输入 → 当回合结束
      //   - hasToolCall('end_scenario')：LLM 终止剧情 → 退出整局
      stopWhen: [
        stepCountIs(maxSteps),
        hasToolCall('signal_input_needed'),
        hasToolCall('end_scenario'),
      ],
      maxOutputTokens,
      abortSignal,
      // Focus Injection D：per-step system prompt 覆盖。每个 step 开始前，
      // 如果上层想根据当前 state 换一份 system，在这里返回新字符串。
      // 返回 undefined → AI SDK 用外层的 `system` 参数。
      //
      // 每 step 实际使用的 system 都存进 stepSystemMap，供 onStepFinish 回传 tracing。
      ...(prepareStepSystem
        ? {
            prepareStep: async ({ stepNumber, steps }: { stepNumber: number; steps: ReadonlyArray<unknown> }) => {
              const sys = await prepareStepSystem({ stepNumber, steps });
              stepSystemMap.set(stepNumber, sys !== undefined ? sys : systemPrompt);
              return sys !== undefined ? { system: sys } : undefined;
            },
          }
        : {}),
      // 捕获每个 step 的完整 input messages（含前序 step 的 tool results）
      // 以及该 step 开始的真实瞬间（tracing 层用作 generation span startTime）。
      experimental_onStepStart: (event) => {
        stepStartAtMap.set(event.stepNumber, new Date());
        // 每个 step 分配一个 UUID 作 batchId —— 该 step 的所有 tool_call /
        // narrative entry 在持久化时会挂这个 id，让 messages-builder 精确分组
        stepBatchIdMap.set(event.stepNumber, crypto.randomUUID());
        currentStepNumber = event.stepNumber;
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
        const { toolName, input } = event.toolCall;
        const output = event.success ? event.output : event.error;
        onToolResultCb?.(toolName, output);
        const logEntry = toolCallLog.find(
          (entry) => entry.name === toolName && entry.result === undefined,
        );
        if (logEntry) {
          logEntry.result = output;
        }

        // migration 0011：把非 signal/end 类 tool_call 透传给上游做持久化。
        // signal_input_needed 走专属 onSignalInputRecorded 路径；end_scenario
        // 走 onScenarioFinished。其余（update_state / change_scene / ...）进 entries。
        if (onToolObserved && toolName !== 'signal_input_needed' && toolName !== 'end_scenario') {
          const batchId = stepBatchIdMap.get(currentStepNumber);
          if (batchId) {
            // fire-and-forget：不阻塞 agentic loop；持久化失败只打 console，
            // 不把异常冒上来影响 LLM stream。上游（game-session / persistence）
            // 自己 catch 异常。
            Promise.resolve(onToolObserved({
              batchId,
              toolName,
              input,
              output,
              success: event.success,
            })).catch((err) => {
              console.error('[llm-client] onToolObserved failed:', err);
            });
          }
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
            // 不受 tool 挂起污染。tracing 层把它作为 generation span 的 endTime。
            responseTimestamp: step.response?.timestamp,
            // 该 step 送给 provider 之前的瞬间。tracing 层作为 startTime。
            stepStartAt: stepStartAtMap.get(step.stepNumber),
            // 该 step 实际看到的完整 messages（从 onStepStart 捕获）
            stepInputMessages: stepInputsMap.get(step.stepNumber),
            // 该 step 实际发给 LLM 的 system（prepareStep 覆盖 or 外层 fallback）
            // —— tracing 层用这个替换 initialInput.systemPrompt 的一次性快照，
            //    让 Langfuse UI 每 step 能看到真实的 system prompt
            effectiveSystemPrompt: stepSystemMap.get(step.stepNumber) ?? systemPrompt,
            // 本 step 的 batchId（migration 0011）供 game-session 持久化 narrative /
            // signal_input entry 时挂载。
            batchId: stepBatchIdMap.get(step.stepNumber),
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
