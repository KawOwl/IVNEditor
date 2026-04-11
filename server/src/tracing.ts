/**
 * Langfuse Tracing — SessionTracing 接口的服务端实现
 *
 * Core 层（src/core/game-session.ts）定义了 SessionTracing 和
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
} from '../../src/core/game-session';

// ============================================================================
// Client 单例
// ============================================================================

const host = process.env.LANGFUSE_HOST;
const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;

const enabled = !!(host && publicKey && secretKey);

/** 单例 Langfuse client，未配置时为 null */
export const langfuse: Langfuse | null = enabled
  ? new Langfuse({
      baseUrl: host,
      publicKey: publicKey!,
      secretKey: secretKey!,
      // flushAt=1 让本地开发时能立刻看到 trace；生产可调大减少请求
      flushAt: process.env.NODE_ENV === 'production' ? 15 : 1,
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
}

/**
 * 为一个 playthrough 创建 SessionTracing 实例。
 * Langfuse 未配置 → 返回 undefined（GameSession 不调用任何追踪方法）
 */
export function createBoundTracing(ctx: BoundTracingContext): SessionTracing | undefined {
  if (!langfuse) return undefined;

  return {
    startGenerateTrace(turn: number, metadata?: Record<string, unknown>): GenerateTraceHandle {
      try {
        const trace = langfuse!.trace({
          name: 'game-generate',
          sessionId: ctx.playthroughId,
          userId: ctx.userId,
          metadata: {
            turn,
            scriptVersionId: ctx.scriptVersionId,
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
          input: { turn, ...metadata },
          output: { restored: true, turn },
          metadata: {
            turn,
            scriptVersionId: ctx.scriptVersionId,
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
  }): void {
    try {
      // 创建一个已完成的 generation span（创建时即 end）
      // 每个 step 一条独立 span，Langfuse UI 里可以看到完整的 agentic loop 时间线
      const startTime = new Date();
      const endTime = new Date();

      // 确定性地判断该 step 是否包含叙事文本：
      // 看 AI SDK content parts 里是否存在 'text' 类型的 part，而不是看 text.length
      const hasNarrative = step.partKinds.includes('text');
      const hasToolCall = step.partKinds.includes('tool-call');
      // span name 后缀：一眼看出是纯工具步还是含叙事
      const kindSuffix = hasNarrative
        ? hasToolCall
          ? 'narrative+tool'
          : 'narrative'
        : hasToolCall
          ? 'tool'
          : 'empty';

      const gen = this.trace.generation({
        name: `llm-step-${step.stepNumber}-${kindSuffix}`,
        model: step.model,
        // 只在第一个 step 带完整上下文；后续 step 的 input 主要是上一轮工具结果
        // 展示简洁起见，都挂初始 input 作为上下文参考
        input: this.initialInput
          ? { system: this.initialInput.systemPrompt, messages: this.initialInput.messages }
          : undefined,
        startTime,
        metadata: {
          stepNumber: step.stepNumber,
          finishReason: step.finishReason,
          partKinds: step.partKinds,
          hasNarrative,
          hasToolCall,
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
        endTime,
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

const NOOP_TRACE_HANDLE: GenerateTraceHandle = {
  setInput: () => {},
  recordStep: () => {},
  startToolCall: () => NOOP_TOOL_HANDLE,
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
