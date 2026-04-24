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

import { streamText, stepCountIs, hasToolCall, tool, zodSchema, type ToolSet, type ModelMessage } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { ToolHandler } from './tool-executor';

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
  /**
   * DeepSeek V4 thinking 模式开关。仅对 openai-compatible provider 生效。
   *   null / undefined → 不传 thinking 字段，走模型默认（V4 系列默认 enabled）
   *   true             → 传 thinking:{type:'enabled'}
   *   false            → 传 thinking:{type:'disabled'}（回避 reasoning_content 回传要求的 escape hatch）
   */
  thinkingEnabled?: boolean | null;
  /**
   * reasoning 强度，仅 thinking 模式生效。
   *   null / undefined → 不传，走模型默认
   *   'high' / 'max'   → 传 reasoning_effort
   * 走 providerOptions.openaiCompatible.reasoningEffort。
   */
  reasoningEffort?: 'high' | 'max' | null;
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
  /**
   * 是否是 signal_input 补刀（post-step follow-up）产生的 step（2026-04-24）。
   *
   * 背景：主 generate 结束时若 LLM 未调用 signal_input_needed / end_scenario，
   * llm-client 会自动追加一次 follow-up streamText，通过 `toolChoice` 强制模型调
   * signal_input_needed。follow-up 产生的 step 仍然走完整 onStep 回调链（用于
   * tracing / 持久化），但调用方（game-session）需要识别它以便：
   *   - **不**覆盖 currentStepBatchId —— 保持在主 generate 最后一个 step 的 batchId，
   *     让后续 narrative 持久化和 follow-up 里的 signal_input 挂在同一 batch，
   *     messages-builder 替换成一个 assistant message 时更干净（narrative + signal
   *     同组，不拆两个 assistant）。
   *   - 在 tracing 上区分标记，方便事后分析"这轮是空停被补刀的还是正常的"。
   *
   * 主 generate 的 step 这个字段为 false / undefined；follow-up 的 step 为 true。
   */
  isFollowup?: boolean;
}

export interface GenerateOptions {
  systemPrompt: string;
  /**
   * AI SDK 原生 ModelMessage —— 允许 assistant 带 ToolCallPart[]，以及
   * 独立的 tool role 消息带 ToolResultPart[]。LLMClient 直接透传给 streamText，
   * 不做任何 flatten / 序列化。
   */
  messages: ModelMessage[];
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
    //
    // DeepSeek V4 thinking 模式控制（2026-04-24 加回 —— 曾在 migration 0006
    // 删掉过，但 V4 系列之后 thinking 参数真实可控、且与 tool_calls 配合时
    // 要求 reasoning_content 回传，必须让管理员能关）：
    //   - `thinkingEnabled` 通过 transformRequestBody 注入到 body.thinking
    //   - `reasoningEffort` 通过 providerOptions.openaiCompatible.reasoningEffort（见 generate()）
    //
    // AI SDK 原生没给 thinking 字段（非 OpenAI 标准），只能 transformRequestBody 塞。
    const thinkingEnabled = this.config.thinkingEnabled;
    const provider = createOpenAICompatible({
      name: this.config.name ?? 'provider',
      baseURL: this.config.baseURL,
      apiKey: this.config.apiKey,
      transformRequestBody:
        thinkingEnabled !== undefined && thinkingEnabled !== null
          ? (body) => ({
              ...body,
              thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' },
            })
          : undefined,
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

    // messages 已经是 AI SDK 原生 ModelMessage —— 直接透传，不再 flatten。
    // 之前这里做 `.map({role, content: m.content})` 把 assistant content 强制
    // 转 string，路径上任何 ToolCallPart[] 都会被丢掉。现在上游 messages-builder
    // 按 batchId 正确投影 tool-call / tool-result，透传给 streamText 即可。
    // reasoning_effort 走 providerOptions —— AI SDK openai-compatible
    // 原生 schema 认识 reasoningEffort（camelCase），会序列化为 reasoning_effort。
    // 仅当 config 里显式设了值才传；null/undefined 时省略字段让模型走默认。
    const reasoningEffort = this.config.reasoningEffort;
    const providerOptions =
      this.config.provider === 'openai-compatible' &&
      reasoningEffort !== undefined &&
      reasoningEffort !== null
        ? { openaiCompatible: { reasoningEffort } }
        : undefined;

    // ─── 主 / follow-up step 共用的回调 ──────────────────────────────────────
    //
    // 抽成 factory 是因为：follow-up（post-step 补刀）用同样的回调结构但要标记
    // isFollowup=true，让 game-session 能区分"主 generate 的 step"和"signal_input
    // 补刀的 step"（详见 StepInfo.isFollowup 注释）。
    //
    // 所有 closure 变量（stepInputsMap / stepBatchIdMap / toolCallLog 等）都是
    // generate() 方法内的 let/const，follow-up 直接复用这些 Map —— 主和 follow-up
    // 的 event.stepNumber 各自从 0 起，Map 里 key 会冲突但我们只需在 step 生命
    // 周期内正确读写即可（onStepFinish 读完 Map 对应的键就不再用）。
    const isFollowupRef = { current: false };

    const handleStepStart = (event: { stepNumber: number; messages?: readonly unknown[] }) => {
      stepStartAtMap.set(event.stepNumber, new Date());
      stepBatchIdMap.set(event.stepNumber, crypto.randomUUID());
      currentStepNumber = event.stepNumber;
      try {
        const simplified = (event.messages ?? []).map((m) => {
          const msg = m as { role: unknown; content: unknown };
          const role = String(msg.role);
          let content: string;
          if (typeof msg.content === 'string') {
            content = msg.content;
          } else if (Array.isArray(msg.content)) {
            // 复合 content（tool calls、tool results、text parts 等）→ 简化
            content = (msg.content as Array<{ type: string; text?: string; toolName?: string; result?: unknown }>)
              .map((part) => {
                if (part.type === 'text') return String(part.text ?? '');
                if (part.type === 'tool-call') return `[tool_call: ${part.toolName}]`;
                if (part.type === 'tool-result') return `[tool_result: ${part.toolName} → ${String(part.result ?? '').slice(0, 200)}]`;
                return `[${part.type}]`;
              })
              .join(' ');
          } else {
            content = JSON.stringify(msg.content).slice(0, 300);
          }
          // 截断过长的 content，保持 trace 体积可控
          if (content.length > 500) content = content.slice(0, 500) + '…';
          return { role, content };
        });
        stepInputsMap.set(event.stepNumber, simplified);
      } catch {
        // 不影响主流程
      }
    };

    const handleToolCallStart = (event: { toolCall: { toolName: string; input: unknown } }) => {
      const { toolName, input } = event.toolCall;
      onToolCallCb?.(toolName, input);
      toolCallLog.push({ name: toolName, args: input, result: undefined });
    };

    const handleToolCallFinish = (event: {
      toolCall: { toolName: string; input: unknown };
      success: boolean;
      output?: unknown;
      error?: unknown;
    }) => {
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
    };

    const handleStepFinish = (step: {
      stepNumber: number;
      text: string;
      reasoningText?: string;
      finishReason: unknown;
      usage?: { inputTokens?: number; outputTokens?: number };
      toolCalls: ReadonlyArray<{ toolName: string; input: unknown }>;
      model?: { modelId?: string };
      content?: ReadonlyArray<{ type: string }>;
      response?: { timestamp?: Date };
    }) => {
      if (!onStep) return;
      try {
        const partKinds = Array.from(
          new Set(((step.content ?? []) as ReadonlyArray<{ type: string }>).map((p) => p.type)),
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
          responseTimestamp: step.response?.timestamp,
          stepStartAt: stepStartAtMap.get(step.stepNumber),
          stepInputMessages: stepInputsMap.get(step.stepNumber),
          effectiveSystemPrompt: stepSystemMap.get(step.stepNumber) ?? systemPrompt,
          batchId: stepBatchIdMap.get(step.stepNumber),
          isFollowup: isFollowupRef.current,
        });
      } catch (err) {
        console.error('[llm-client] onStep handler threw:', err);
      }
    };

    const result = streamText({
      model: this.getModel(),
      system: systemPrompt,
      messages,
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
      ...(providerOptions ? { providerOptions } : {}),
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
      experimental_onStepStart: handleStepStart,
      experimental_onToolCallStart: handleToolCallStart,
      experimental_onToolCallFinish: handleToolCallFinish,
      onStepFinish: handleStepFinish,
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
    let finishReason = await finalResult.finishReason;

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

    // ─── post-step 补刀（方案 A，2026-04-24） ───────────────────────────────
    //
    // 背景：主 generate 结束时如果 LLM 没有调用 signal_input_needed /
    // end_scenario（典型 finishReason='stop' 自然停、或 'length' 撞 token 上
    // 限），就会出现"空停"——玩家看到一段旁白，但既没有选项也没有自由输入
    // 提示，UI 只能 fallback 到 freetext 兜底。v2.6+ 这在长场景里越来越频繁
    // （prompt 很明确但 LLM 仍然漏叫，详见 trace 9a833ccb 的分析）。
    //
    // 补刀策略：再发一次 streamText，用 toolChoice: { type:'tool',
    // toolName: 'signal_input_needed' } 在 provider 解码层强制模型选这个工
    // 具 —— 这是协议级保证，不再依赖 prompt 里的"必须调用"提示词。
    //
    // 对 narrativeEntries 的影响（关键设计）：
    //   1. 主 generate 最后一个 step 的 onStep 回调把 currentStepBatchId 设
    //      到 mainLastBatchId
    //   2. follow-up step 的 handleStepStart 在 llm-client 本地 Map 里生成
    //      新 batchId，但 AI SDK 的 tool.execute（signal_input_needed）在
    //      follow-up step 的 onStepFinish 之前触发
    //   3. execute 里 recordPendingSignal 读 game-session 的
    //      currentStepBatchId，此时仍是 mainLastBatchId → signal_input entry
    //      挂 mainLastBatchId ✓
    //   4. follow-up step 的 onStepFinish 带 isFollowup=true 触发
    //      game-session 的 onStep 回调，游戏层要识别并**跳过**更新
    //      currentStepBatchId（见 game-session.ts 的 !step.isFollowup 判
    //      断），保持 mainLastBatchId
    //   5. generate() 返回后 game-session 在 coreLoop flush
    //      currentNarrativeBuffer 进 narrative_entries，batchId 仍是
    //      mainLastBatchId → narrative entry 也挂 mainLastBatchId ✓
    //
    // 最终 narrative + signal_input 落在同一个 batchId，messages-builder 按
    // batchId 分组后投成一个干净的 assistant message（reasoning + text +
    // tool_call）。比现状两 step 主生成时拆成两个 assistant message 更清爽，
    // 且对 DeepSeek V4 thinking 模式 replay（要求 reasoning_content 在带
    // tool_calls 的 assistant message 上）完全兼容——reasoning 来自主最后
    // 一 step 的 narrative entry，tool_call 来自同 batch 的 signal_input
    // entry，一起上车。
    //
    // 失败处理：任何 follow-up 异常（provider 错误、模型仍拒绝调工具、abort）
    // 都只 warn/log，不把异常冒上来影响主 generate 的结果。空停兜底到
    // freetext 的老路径比阻塞用户体验好。
    const hasTerminatingTool = toolCallLog.some(
      (c) => c.name === 'signal_input_needed' || c.name === 'end_scenario',
    );
    const aborted = abortSignal?.aborted ?? false;

    if (!hasTerminatingTool && !aborted) {
      isFollowupRef.current = true;
      try {
        const tailContext = fullText.slice(-1500);
        const nudgeMessage: ModelMessage = {
          role: 'user',
          content:
            '[引擎提示] 你刚才输出了一段旁白但没有调用 signal_input_needed / end_scenario 来标记本轮结束，玩家端没有收到选项或输入提示。' +
            (tailContext
              ? `\n\n以下是你刚才输出的尾部片段，用于回忆上下文：\n---\n${tailContext}\n---\n\n`
              : '\n\n') +
            '现在立即调用 signal_input_needed：把当前局面总结为 hint（1-2 句），并提供 2-4 个推进选项作为 choices。不要再写任何旁白文本或 <d> 标签。',
        };
        const followupStream = streamText({
          model: this.getModel(),
          system: systemPrompt,
          messages: [...messages, nudgeMessage],
          tools: aiTools,
          // 硬 cap 2 步：正常情况 step 0 就应该调到 signal_input_needed，
          // 留 1 步冗余以防 provider 先吐 text 再 tool_call 分步走。
          stopWhen: [
            hasToolCall('signal_input_needed'),
            hasToolCall('end_scenario'),
            stepCountIs(2),
          ],
          maxOutputTokens: 1024,
          // 协议级强制：Anthropic 和 OpenAI-compatible 都支持 per-call
          // tool 强制（解码器层面）。这是和主 generate 语义最大差别：
          // 主 generate 用 'auto'，让 LLM 自由叙事；follow-up 用具名 tool
          // 强制，保证一定产生 signal_input_needed tool_call。
          toolChoice: { type: 'tool', toolName: 'signal_input_needed' },
          abortSignal,
          ...(providerOptions ? { providerOptions } : {}),
          experimental_onStepStart: handleStepStart,
          experimental_onToolCallStart: handleToolCallStart,
          experimental_onToolCallFinish: handleToolCallFinish,
          onStepFinish: handleStepFinish,
        });

        // 耗尽 follow-up 流。
        //   - text-delta：**不**累加进 fullText。toolChoice 下模型通常不
        //     会产生 text，即便产生也是"我要调工具"这种元说明，不该写进
        //     玩家看到的叙事。onTextChunk 同理不转发，避免前端看到跳字。
        //   - reasoning-delta：同理忽略。
        for await (const part of followupStream.fullStream) {
          void part; // drain only
        }

        const followupFinal = await followupStream;
        const followupFinish = await followupFinal.finishReason;

        // 合并 usage（input/output token 相加）
        try {
          const fu = await followupFinal.usage;
          if (fu) {
            usage = {
              inputTokens: (usage?.inputTokens ?? 0) + (fu.inputTokens ?? 0),
              outputTokens: (usage?.outputTokens ?? 0) + (fu.outputTokens ?? 0),
              totalTokens: (usage?.totalTokens ?? 0) + (fu.totalTokens ?? 0),
            };
          }
        } catch {
          // ignore
        }

        // toolCallLog 在 handleToolCallFinish 已经被 follow-up 的
        // signal_input_needed 追加过，这里重新检查确认补刀成功。
        const followupGotSignal = toolCallLog.some(
          (c) => c.name === 'signal_input_needed' || c.name === 'end_scenario',
        );
        if (followupGotSignal) {
          // 让上游看到正确的 finishReason（主 'stop' → 改成 'tool-calls'）
          // —— tracing 依赖它区分本轮是否正常收尾。
          finishReason = 'tool-calls';
        } else {
          console.warn(
            `[llm-client] follow-up streamText finished without eliciting ` +
              `signal_input_needed. followupFinish=${String(followupFinish)}, ` +
              `mainFinish=${String(finishReason)}`,
          );
        }
      } catch (err) {
        console.error('[llm-client] follow-up streamText threw:', err);
      } finally {
        isFollowupRef.current = false;
      }
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
