/**
 * Narrative Retry-Main — 输入输出类型
 *
 * retry-main 处理一类 rewriter 救不了的 case：main path LLM **根本没写**
 * 玩家可读的 narration / dialogue（典型：trace 93f1f0a9 turn 17，输出
 * `<scratch>...</scratch>` 然后 stop）。这种情况 raw 里没有可包 tag 的
 * prose 原料，rewriter 凭 "不补剧情" 硬约束只能保留原 raw → 玩家本轮看到空。
 *
 * retry-main 是同一个 GM persona 重新跑一次主路径，让它**重新输出本轮的正文**。
 * 跟 rewriter 互补：
 * - rewriter：有内容、格式差 → 重写格式（不补内容）
 * - retry-main：根本没写 → 重新生成（允许补内容，因为它就是 GM）
 *
 * 决定何时触发、跟 rewriter 串/并行、用什么 reason 落库由 caller（game-session）
 * 协调；retry-main 自己只关心：给定 raw + history → 调一次 LLM → verifyParse →
 * 返回结果。
 */

import type { ModelMessage } from 'ai';
import type { ParserManifest, DegradeEvent } from '#internal/narrative-parser-v2';
import type { ParserVerifyResult } from '#internal/narrative-rewrite';

// ============================================================================
// retry-main 输入
// ============================================================================

export interface RetryMainInput {
  /**
   * Main path 这一轮的全部 raw 输出（含 scratch / 工具文本累积等）。
   *
   * 会作为一条 assistant message 拼到 main path messages 末尾，让 LLM 看到
   * "我刚才输出了什么"——避免它困惑为什么要重新生成本轮。
   */
  readonly rawText: string;
  /** Main path 进入时的 system prompt（context-assembler 产出，retry-main 沿用同款 GM 人格） */
  readonly mainPathSystemPrompt: string;
  /**
   * Main path 进入时的 messages 序列（不含本轮 LLM 输出）。retry-main 在末尾
   * 追加 assistant(raw) + user(nudge) 后整体作为新一次 LLM call 的 messages。
   */
  readonly mainPathMessages: ReadonlyArray<ModelMessage>;
  /** Turn 号，trace metadata 用。retry-main 自身不依赖。 */
  readonly turn: number;
  /** abort 信号（caller 上游 cancel 时透传） */
  readonly abortSignal?: AbortSignal;
}

// ============================================================================
// retry-main 调用注入（轻量 LLM 调用接口）
// ============================================================================

/**
 * 给 retry-main 的最小 LLM 调用接口。caller（game-session）持有 LLMClient
 * 实例，包一个 thin adapter 满足这个 shape；harness 直接 mock 这个函数。
 *
 * 跟 RewriteInvoke 的区别：retry-main 接 messages 序列（含 main path history），
 * rewriter 接单条 userMessage。两者都不许带 tools——retry-main 强制只能出
 * narrative text，禁所有 tool（signal_input_needed 已由 main path / post-step
 * fallback 处理）。
 */
export interface RetryMainInvoke {
  (opts: {
    systemPrompt: string;
    messages: ReadonlyArray<ModelMessage>;
    abortSignal?: AbortSignal;
  }): Promise<RetryMainInvokeResult>;
}

export interface RetryMainInvokeResult {
  readonly text: string;
  readonly finishReason: string;
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

// ============================================================================
// retry-main 依赖
// ============================================================================

/**
 * Tracing 接口（最小子集）。本模块**不直接**依赖 SessionTracing 类型，
 * 跟 rewriter 同设计——caller 包一个适配器满足这个 shape。
 */
export interface RetryMainTraceHook {
  start(input: {
    systemPrompt: string;
    messageCount: number;
    rawTextLength: number;
  }): RetryMainTraceSpan;
}

export interface RetryMainTraceSpan {
  end(opts: {
    text?: string;
    finishReason?: string;
    inputTokens?: number;
    outputTokens?: number;
    error?: string;
    fallbackReason?: RetryMainFallbackReason;
  }): void;
}

export interface RetryMainDeps {
  readonly invoke: RetryMainInvoke;
  readonly trace?: RetryMainTraceHook;
  /**
   * 二次 parser 校验函数。caller 注入（避免 retry-main 直接 import parser-v2
   * 形成 module 循环；也方便 harness mock）。verify 跟 rewriter 复用同一函数。
   */
  readonly verifyParse: (text: string, manifest: ParserManifest) => ParserVerifyResult;
  readonly parserManifest: ParserManifest;
  /**
   * 失败重试上限。默认 0（不重试）—— retry-main 本身已经是兜底层，再重试
   * 边际收益低、延迟翻倍；caller 决定要不要再 chain rewrite 救场。
   * @default 0
   */
  readonly maxRetries?: number;
}

// ============================================================================
// retry-main 输出
// ============================================================================

export type RetryMainFallbackReason =
  | 'api-error'
  | 'second-parse-failed'
  | 'still-empty'
  | 'aborted';

export type RetryMainStatus =
  | 'ok'                   // retry-main 完成 + 二次校验通过（sentenceCount > 0）
  | 'skipped-empty'        // input.rawText 为空白 → 完全没素材，retry-main 也无意义
  | 'skipped-aborted'      // abort signal 已 abort
  | 'fallback';            // retry-main 失败或二次校验未通过

export interface RetryMainResult {
  readonly status: RetryMainStatus;
  /** retry-main 输出（status='ok' 时是干净 tagged；fallback 时可能是 raw 或最近一次 retry-main 输出） */
  readonly text: string;
  /** 二次 parser 校验结果（只在 retry-main 真的发出来时有；skip 时为 null） */
  readonly verified: ParserVerifyResult | null;
  /** retry-main 实际尝试次数（含首次） */
  readonly attempts: number;
  readonly fallbackReason: RetryMainFallbackReason | null;
  readonly latencyMs: number;
  readonly model: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** 空 result 工厂——skip 路径用 */
export function emptyRetryMainResult(
  status: 'skipped-empty' | 'skipped-aborted',
  rawText: string,
): RetryMainResult {
  return {
    status,
    text: rawText,
    verified: null,
    attempts: 0,
    fallbackReason: null,
    latencyMs: 0,
    model: null,
    inputTokens: 0,
    outputTokens: 0,
  };
}

// ============================================================================
// Re-export 给 caller 用
// ============================================================================

export type { ModelMessage };
export type { ParserManifest, DegradeEvent };
