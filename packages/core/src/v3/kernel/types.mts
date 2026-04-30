import type { LanguageModel, ModelMessage } from 'ai';
import type { ZodSchema } from 'zod';

// ──────────────────────────────────────────────────────────
// Tool — caller-injected
// ──────────────────────────────────────────────────────────

export type ToolContext = {
  readonly callId: string;
  readonly abortSignal: AbortSignal;
};

export type Tool<Args = unknown, Output = unknown> = {
  readonly description: string;
  readonly inputSchema: ZodSchema<Args>;
  readonly execute: (args: Args, ctx: ToolContext) => Promise<Output>;
};

export type ToolSet = Readonly<Record<string, Tool>>;

// ──────────────────────────────────────────────────────────
// RunInput — kernel entry
// kernel 只知道 `system: string`（已拼好），不知 Section / Budget 概念。
// 拼装由 caller 自决（v3 lib 提供 packSections helper 在 v3/assemble.mts，
// caller 选用即可）。
// ──────────────────────────────────────────────────────────

export type RunInput = {
  readonly model: LanguageModel;
  readonly system: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: ToolSet;
  readonly abortSignal?: AbortSignal;
  readonly maxSteps?: number;
};

// ──────────────────────────────────────────────────────────
// SourceEvent — driver-internal: AI SDK part / tool result fed to step()
// ──────────────────────────────────────────────────────────

export type FinishReason =
  | 'stop'
  | 'tool-calls'
  | 'length'
  | 'content-filter'
  | 'error'
  | 'other'
  | 'unknown';

export type TokenUsage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens?: number;
};

export type ToolCallRecord = {
  readonly callId: string;
  readonly name: string;
  readonly args: unknown;
  readonly output?: unknown;
  readonly error?: string;
};

export type SourceEvent =
  | { readonly kind: 'llm-text-delta'; readonly text: string }
  | { readonly kind: 'llm-reasoning-delta'; readonly text: string }
  | {
      readonly kind: 'llm-tool-call';
      readonly callId: string;
      readonly name: string;
      readonly args: unknown;
    }
  | {
      readonly kind: 'llm-step-finish';
      readonly reason: FinishReason;
      readonly usage: TokenUsage;
    }
  | { readonly kind: 'tool-result'; readonly callId: string; readonly output: unknown }
  | { readonly kind: 'tool-error'; readonly callId: string; readonly error: string };

// ──────────────────────────────────────────────────────────
// KernelEvent — public stream output
// ──────────────────────────────────────────────────────────

export type KernelEvent =
  | { readonly type: 'step-started'; readonly step: number }
  | { readonly type: 'text-delta'; readonly text: string }
  | { readonly type: 'reasoning-delta'; readonly text: string }
  | {
      readonly type: 'tool-call';
      readonly callId: string;
      readonly name: string;
      readonly args: unknown;
    }
  | { readonly type: 'tool-result'; readonly callId: string; readonly output: unknown }
  | { readonly type: 'tool-error'; readonly callId: string; readonly error: string }
  | {
      readonly type: 'step-finished';
      readonly finishReason: FinishReason;
      readonly usage: TokenUsage;
    }
  | {
      readonly type: 'final';
      readonly finishReason: FinishReason;
      readonly toolCallsCompleted: readonly ToolCallRecord[];
      readonly text: string;
    };

// ──────────────────────────────────────────────────────────
// Decision — step() output, dispatched by driver, not in public stream
// ──────────────────────────────────────────────────────────

export type Decision =
  | { readonly kind: 'emit'; readonly event: KernelEvent }
  | {
      readonly kind: 'exec-tool';
      readonly callId: string;
      readonly name: string;
      readonly args: unknown;
    }
  | { readonly kind: 'finish' };

export type { ModelMessage } from 'ai';
