/**
 * Langfuse Tracing — SessionTracing 接口的服务端实现
 *
 * Core 层（packages/core/src/game-session.ts）定义了 SessionTracing 和
 * GenerateTraceHandle 接口，本文件用 langfuse SDK 提供具体实现。
 *
 * 设计原则：
 *   1. 可选：三个 env 任一为空 → createBoundTracing 返回 undefined
 *      GameSession 看到 undefined 后所有观测操作自动 noop
 *   2. 失败不抛：任何 Langfuse 调用失败都 try/catch，不影响主业务
 *   3. 每个 playthrough 绑定一个 SessionTracing 实例
 *      SessionManager 在创建 wrapper 时调用 createBoundTracing(playthroughId, userId)
 */

import { Langfuse, type LangfuseTraceClient } from 'langfuse';
import type {
  SessionTracing,
  GenerateTraceHandle,
  ToolCallTraceHandle,
  NestedGenerationTraceHandle,
} from '@ivn/core/game-session';
import { getServerEnv } from '#internal/env';

// ============================================================================
// Client 单例
// ============================================================================

const env = getServerEnv();
const host = env.LANGFUSE_HOST;
const publicKey = env.LANGFUSE_PUBLIC_KEY;
const secretKey = env.LANGFUSE_SECRET_KEY;

const enabled = !!(host && publicKey && secretKey);

/** 单例 Langfuse client，未配置时为 null */
export const langfuse: Langfuse | null = enabled
  ? new Langfuse({
      baseUrl: host,
      publicKey: publicKey!,
      secretKey: secretKey!,
      // flushAt=1 让本地开发时能立刻看到 trace；生产可调大减少请求
      flushAt: env.NODE_ENV === 'production' ? 15 : 1,
      flushInterval: 1000,
    })
  : null;

if (enabled) {
  console.log(`[Tracing] Langfuse enabled → ${host}`);
} else {
  console.log('[Tracing] Langfuse disabled (LANGFUSE_HOST/PUBLIC_KEY/SECRET_KEY 未全部配置)');
}

// ============================================================================
// Bound SessionTracing — 为一个 playthrough 创建绑定实例
// ============================================================================

export interface BoundTracingContext {
  playthroughId: string;  // → Langfuse sessionId
  userId: string;         // → Langfuse userId
  scriptVersionId: string;
  /** 'production' | 'playtest'，用于在 Langfuse 区分编辑器试玩 */
  kind?: string;
}

/**
 * 为一个 playthrough 创建 SessionTracing 实例。
 * Langfuse 未配置 → 返回 undefined（GameSession 不调用任何追踪方法）
 */
export function createBoundTracing(ctx: BoundTracingContext): SessionTracing | undefined {
  if (!langfuse) return undefined;

  // playtest → 用 'editor-playtest' 作为 trace tag，方便在 Langfuse UI
  // 里筛选/隐藏编剧试玩流量
  const traceTags = ctx.kind === 'playtest' ? ['editor-playtest'] : ['production'];

  return {
    startGenerateTrace(turn: number, metadata?: Record<string, unknown>): GenerateTraceHandle {
      try {
        const trace = langfuse!.trace({
          name: 'game-generate',
          sessionId: ctx.playthroughId,
          userId: ctx.userId,
          tags: traceTags,
          metadata: {
            turn,
            scriptVersionId: ctx.scriptVersionId,
            kind: ctx.kind,
            ...metadata,
          },
        });
        return new LangfuseGenerateTraceHandle(trace);
      } catch (err) {
        console.error('[Tracing] startGenerateTrace failed:', err);
        return NOOP_TRACE_HANDLE;
      }
    },

    markSessionRestored(turn: number, metadata?: Record<string, unknown>): void {
      try {
        const trace = langfuse!.trace({
          name: 'session-restored',
          sessionId: ctx.playthroughId,
          userId: ctx.userId,
          tags: traceTags,
          input: { turn, ...metadata },
          output: { restored: true, turn },
          metadata: {
            turn,
            scriptVersionId: ctx.scriptVersionId,
            kind: ctx.kind,
            ...metadata,
          },
        });
        // 创建并立即结束一个 span，确保 trace 被可靠上传
        // （Langfuse 只含 trace.event 的 trace 不保证 flush）
        const span = trace.span({
          name: 'restore-marker',
          input: { turn },
        });
        span.end({ output: 'ok' });
      } catch (err) {
        console.error('[Tracing] markSessionRestored failed:', err);
      }
    },
  };
}

// ============================================================================
// Real implementation
// ============================================================================

class LangfuseGenerateTraceHandle implements GenerateTraceHandle {
  /** 初始 systemPrompt + messages，供每个 step 的 generation span 复用 */
  private initialInput: {
    systemPrompt: string;
    messages: Array<{ role: string; content: string }>;
  } | null = null;

  constructor(private trace: LangfuseTraceClient) {}

  setInput(input: {
    systemPrompt: string;
    messages: Array<{ role: string; content: string }>;
  }): void {
    this.initialInput = input;
    try {
      this.trace.update({
        input: {
          system: input.systemPrompt,
          messages: input.messages,
        },
      });
    } catch (err) {
      console.error('[Tracing] setInput failed:', err);
    }
  }

  recordStep(step: {
    stepNumber: number;
    text: string;
    reasoning?: string;
    finishReason: string;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
    partKinds: string[];
    responseTimestamp?: Date;
    stepStartAt?: Date;
    stepInputMessages?: Array<{ role: string; content: string }>;
    /** 该 step 实际发给 LLM 的 system（Focus Injection D）。没有则 fallback 到 initialInput.systemPrompt */
    effectiveSystemPrompt?: string;
    /**
     * 该 step 是否为 llm-client 的 post-step 补刀（2026-04-24）。
     * 在 Langfuse metadata 里暴露出来，方便按这个维度过滤/分析 "本轮是否被补刀触发"。
     */
    isFollowup?: boolean;
  }): void {
    try {
      // 创建一个已完成的 generation span（创建时即 end）
      // 每个 step 一条独立 span，Langfuse UI 里可以看到完整的 agentic loop 时间线
      //
      // 时间戳策略：
      //   - startTime  = step.stepStartAt   （onStepStart 捕获的"发 provider 前"瞬间）
      //   - completionStartTime = step.responseTimestamp（LLM 开始响应的瞬间，= TTFT 终点）
      //   两者配对得到该 step 的 TTFT 时长。不用 onStepFinish 的 Date.now()
      //   作完成起点，避免被同 step 内 signal_input_needed 挂起（等玩家输入）污染。
      //   历史上两头都用 responseTimestamp 导致 duration=0 + 时间轴错乱，
      //   本修复把 startTime 换成真正的 step 起点。
      const startTime = step.stepStartAt ?? step.responseTimestamp ?? new Date();
      let endTime = step.responseTimestamp ?? startTime;
      // 防御：个别 provider 的时钟或 clock skew 可能让 responseTimestamp 早于
      // stepStartAt。保证 endTime >= startTime 以免 UI 里出现负 duration。
      if (endTime.getTime() < startTime.getTime()) {
        endTime = startTime;
      }

      // 确定性地判断该 step 是否包含叙事文本：
      const hasNarrative = step.partKinds.includes('text');
      const hasToolCall = step.partKinds.includes('tool-call');
      const kindSuffix = hasNarrative
        ? hasToolCall
          ? 'narrative+tool'
          : 'narrative'
        : hasToolCall
          ? 'tool'
          : 'empty';
      // follow-up step（补刀）在 name 上加一个后缀，在 Langfuse UI 可视区分
      const nameSuffix = step.isFollowup ? '-followup' : '';

      // --- Input 策略 ---
      // 优先用 stepInputMessages（来自 experimental_onStepStart，是该 step
      // 发给 LLM 的完整 messages，包含前序 steps 的 tool call + result）。
      // 这样 Langfuse UI 里每个 step 都能看到 LLM **实际看到的**完整上下文，
      // 而不只是初始的 "开始游戏" 一条。
      // fallback 到 initialInput（只有初始 systemPrompt + messages）。
      //
      // Focus Injection D 后的修正：system 字段优先用 effectiveSystemPrompt
      //（本 step 实际发给 LLM 的 system），只有没传时才 fallback 到 initialInput.
      // 否则 per-step 切换的 system 在 Langfuse 里完全不可见。
      const stepSystem = step.effectiveSystemPrompt
        ?? this.initialInput?.systemPrompt
        ?? '(system prompt omitted)';
      const stepInput = step.stepInputMessages
        ? {
            system: stepSystem,
            messages: step.stepInputMessages,
            _messageCount: step.stepInputMessages.length,
          }
        : this.initialInput
          ? { system: stepSystem, messages: this.initialInput.messages }
          : undefined;

      const gen = this.trace.generation({
        name: `llm-step-${step.stepNumber}-${kindSuffix}${nameSuffix}`,
        model: step.model,
        input: stepInput,
        startTime,
        completionStartTime: endTime,
        metadata: {
          stepNumber: step.stepNumber,
          finishReason: step.finishReason,
          partKinds: step.partKinds,
          hasNarrative,
          hasToolCall,
          messageCount: step.stepInputMessages?.length ?? 0,
          isFollowup: step.isFollowup === true,
        },
      });
      gen.end({
        output: {
          text: step.text,
          reasoning: step.reasoning,
        },
        usage: {
          input: step.inputTokens,
          output: step.outputTokens,
        },
      });
    } catch (err) {
      console.error('[Tracing] recordStep failed:', err);
    }
  }

  startToolCall(name: string, args: unknown): ToolCallTraceHandle {
    try {
      const span = this.trace.span({
        name: `tool:${name}`,
        input: args,
      });
      return {
        end: (output: unknown, error?: string) => {
          try {
            if (error) {
              span.end({ output, level: 'ERROR', statusMessage: error });
            } else {
              span.end({ output });
            }
          } catch (err) {
            console.error('[Tracing] tool span end failed:', err);
          }
        },
      };
    } catch (err) {
      console.error('[Tracing] startToolCall failed:', err);
      return NOOP_TOOL_HANDLE;
    }
  }

  startNestedGeneration(opts: {
    name: string;
    model?: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
  }): NestedGenerationTraceHandle {
    try {
      const startTime = new Date();
      const gen = this.trace.generation({
        name: opts.name,
        model: opts.model,
        input: opts.input,
        startTime,
        metadata: opts.metadata,
      });
      return {
        end: (endOpts: {
          text?: string;
          finishReason?: string;
          inputTokens?: number;
          outputTokens?: number;
          error?: string;
          metadata?: Record<string, unknown>;
        }) => {
          try {
            const usage = endOpts.inputTokens != null || endOpts.outputTokens != null
              ? { input: endOpts.inputTokens, output: endOpts.outputTokens }
              : undefined;
            if (endOpts.error) {
              gen.end({
                output: endOpts.text,
                level: 'ERROR',
                statusMessage: endOpts.error,
                usage,
                metadata: endOpts.metadata,
              });
            } else {
              gen.end({
                output: endOpts.text != null
                  ? { text: endOpts.text, finishReason: endOpts.finishReason }
                  : undefined,
                usage,
                metadata: endOpts.metadata,
              });
            }
          } catch (err) {
            console.error('[Tracing] nested generation end failed:', err);
          }
        },
      };
    } catch (err) {
      console.error('[Tracing] startNestedGeneration failed:', err);
      return NOOP_NESTED_GEN_HANDLE;
    }
  }

  event(name: string, input?: unknown, metadata?: Record<string, unknown>): void {
    try {
      this.trace.event({
        name,
        input,
        metadata,
      });
    } catch (err) {
      console.error('[Tracing] event failed:', err);
    }
  }

  error(message: string, phase: string): void {
    try {
      this.trace.event({
        name: 'error',
        level: 'ERROR',
        statusMessage: message,
        metadata: { phase },
      });
    } catch (err) {
      console.error('[Tracing] error event failed:', err);
    }
  }

  end(finalOutput?: unknown): void {
    try {
      this.trace.update({ output: finalOutput });
    } catch (err) {
      console.error('[Tracing] trace.update failed:', err);
    }
  }
}

// ============================================================================
// Noop handles（用于 Langfuse 错误时的降级）
// ============================================================================

const NOOP_TOOL_HANDLE: ToolCallTraceHandle = {
  end: () => {},
};

const NOOP_NESTED_GEN_HANDLE: NestedGenerationTraceHandle = {
  end: () => {},
};

const NOOP_TRACE_HANDLE: GenerateTraceHandle = {
  setInput: () => {},
  recordStep: () => {},
  startToolCall: () => NOOP_TOOL_HANDLE,
  startNestedGeneration: () => NOOP_NESTED_GEN_HANDLE,
  event: () => {},
  error: () => {},
  end: () => {},
};

// ============================================================================
// Graceful shutdown
// ============================================================================

/**
 * 进程退出前刷新待上传的 trace
 */
export async function flushTracing(): Promise<void> {
  if (!langfuse) return;
  try {
    await langfuse.flushAsync();
  } catch (err) {
    console.error('[Tracing] flush failed:', err);
  }
}

/**
 * 完全关闭 Langfuse client
 */
export async function shutdownTracing(): Promise<void> {
  if (!langfuse) return;
  try {
    await langfuse.shutdownAsync();
  } catch (err) {
    console.error('[Tracing] shutdown failed:', err);
  }
}
