/**
 * Narrative Rewrite — 输入输出类型
 *
 * rewriter 是 LLM 主路径之后的"语义归一化层"：把每轮 raw fullText 重写成
 * 严格符合 IVN XML 协议的 tagged 输出。设计上是纯函数（依赖通过 deps 注入），
 * 让 harness 可以独立 eval / 重放 production trace。
 *
 * 触发条件、tracing 钩子、与主路径的集成在 game-session 层，不在本模块。
 *
 * PR1：仅记录不替换 → result.status 标识结果，caller 不消费 text
 * PR2：开启替换 + 二次校验 retry → caller 用 result.text 替换 buffer
 * PR3：UI 选项 C 流式 reveal → caller 通过 deps.invoke.onTextChunk 拿增量
 */

import type { Sentence } from '#internal/types';
import type { DegradeEvent, ParserManifest } from '#internal/narrative-parser-v2';

// ============================================================================
// Parser View（第一遍 parser-v2 的解读结果，作为 hint 喂给 rewriter）
// ============================================================================

export interface ParserView {
  /** parser 第一遍 emit 的 sentence（不含 scene_change 等运行时不传给 LLM 的） */
  readonly sentences: readonly Sentence[];
  /** scratch block 数（具体内容 LLM 不需要知道） */
  readonly scratchCount: number;
  /** parser degrade 事件（typo / unknown tag / bare text 等） */
  readonly degrades: readonly DegradeEvent[];
  /**
   * parser 解读是否"明显不对劲"——主要触发：sentence 数 0 / 有 degrade /
   * 全 scratch。caller 计算后传进来，rewriter 不重复判断。仅作 trace 标签用，
   * 不影响 rewrite 是否触发（按 PR3 设计 100% 流量过 rewrite）。
   */
  readonly looksBroken: boolean;
}

// ============================================================================
// Manifest Summary（剧本资产白名单的精简版，给 rewriter 校验 id）
// ============================================================================

export interface ManifestSummary {
  /** 角色 id 白名单（不含 __npc__ 前缀的 ad-hoc） */
  readonly characterIds: readonly string[];
  /** 背景 id 白名单 */
  readonly backgroundIds: readonly string[];
  /** 每角色情绪白名单 (charId → moodIds[]) */
  readonly moodsByCharacter: Readonly<Record<string, readonly string[]>>;
}

/** 从 ParserManifest 抽出 rewriter 需要的精简视图 */
export function summarizeManifest(manifest: ParserManifest): ManifestSummary {
  const moodsByCharacter: Record<string, readonly string[]> = {};
  for (const [charId, moods] of manifest.moodsByChar) {
    moodsByCharacter[charId] = [...moods];
  }
  return {
    characterIds: [...manifest.characters],
    backgroundIds: [...manifest.backgrounds],
    moodsByCharacter,
  };
}

// ============================================================================
// Rewriter 输入
// ============================================================================

export interface RewriteInput {
  /** 这一轮 LLM 主路径全部完成后的原始输出（含 followup 的累加文本） */
  readonly rawText: string;
  /** parser 第一次跑完的解读结果 */
  readonly parserView: ParserView;
  /** 剧本资产摘要（用于校验 id 是否在白名单内） */
  readonly manifest: ManifestSummary;
  /**
   * Turn 号，用于 trace metadata。rewriter 本身不依赖。
   */
  readonly turn: number;
  /** abort 信号（caller 上游 cancel 时透传） */
  readonly abortSignal?: AbortSignal;
}

// ============================================================================
// Rewriter 调用注入（轻量 LLM 调用接口）
// ============================================================================

/**
 * 给 rewriter 的最小 LLM 调用接口。caller（game-session）持有 LLMClient
 * 实例，包一个 thin adapter 满足这个 shape；harness 直接 mock 这个函数。
 *
 * 流式 hook（onTextChunk）PR3 才用，PR1/PR2 可不传。
 */
export interface RewriteInvoke {
  (opts: {
    systemPrompt: string;
    userMessage: string;
    onTextChunk?: (chunk: string) => void;
    abortSignal?: AbortSignal;
  }): Promise<RewriteInvokeResult>;
}

export interface RewriteInvokeResult {
  readonly text: string;
  readonly finishReason: string;
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

// ============================================================================
// Rewriter 依赖
// ============================================================================

/**
 * Tracing 接口（最小子集）。本模块**不直接**依赖 SessionTracing 类型，
 * 避免跨包循环——caller 包一个适配器满足这个 shape。
 */
export interface RewriteTraceHook {
  /** 开始 nested generation；end 时传 output/usage/error。 */
  start(input: { systemPrompt: string; userMessage: string; model?: string }): RewriteTraceSpan;
}

export interface RewriteTraceSpan {
  end(opts: {
    text?: string;
    finishReason?: string;
    inputTokens?: number;
    outputTokens?: number;
    error?: string;
    fallbackReason?: RewriteFallbackReason;
  }): void;
}

export interface RewriteDeps {
  readonly invoke: RewriteInvoke;
  readonly trace?: RewriteTraceHook;
  /**
   * 二次 parser 校验函数。caller 注入（避免 rewriter 直接 import parser-v2
   * 形成 module 循环；也方便 harness mock）。
   */
  readonly verifyParse: (text: string, manifest: ParserManifest) => ParserVerifyResult;
  /**
   * 校验时需要的 manifest——`verifyParse` 用。和 RewriteInput.manifest 不同，
   * 后者是给 LLM 的精简摘要，这里是真 ParserManifest。
   */
  readonly parserManifest: ParserManifest;
  /**
   * 失败重试上限。PR1 = 0（不重试），PR2 起 = 1。
   * @default 0
   */
  readonly maxRetries?: number;
}

export interface ParserVerifyResult {
  readonly sentenceCount: number;
  readonly scratchCount: number;
  readonly degrades: readonly DegradeEvent[];
}

// ============================================================================
// Rewriter 输出
// ============================================================================

export type RewriteFallbackReason =
  | 'api-error'
  | 'second-parse-failed'
  | 'rewrite-still-empty'
  | 'aborted';

export type RewriteStatus =
  | 'ok'                       // rewrite 完成 + 二次校验通过
  | 'skipped-empty'            // input.rawText 为空白 → skip
  | 'skipped-aborted'          // abort signal 已 abort
  | 'skipped-non-actionable'   // 仅有 non-actionable degrade（如合规 ad-hoc speaker / truncated），无需 rewrite
  | 'fallback';                // rewrite 失败或二次校验未通过；caller 应当沿用 raw

export interface RewriteResult {
  readonly status: RewriteStatus;
  /** rewrite 输出（status='ok' 时是干净 tagged；fallback 时可能是 raw 或最近一次 rewrite 输出） */
  readonly text: string;
  /** 二次 parser 校验结果（只在 rewrite 真的发出来时有；skip 时为 null） */
  readonly verified: ParserVerifyResult | null;
  /** rewrite 实际尝试次数（含首次） */
  readonly attempts: number;
  /** fallback 时记录原因 */
  readonly fallbackReason: RewriteFallbackReason | null;
  /** 总耗时（毫秒），调试用 */
  readonly latencyMs: number;
  /** 模型名（来自 invoke 返回） */
  readonly model: string | null;
  /** 累计 token 用量 */
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** 空 result 工厂——skip 路径用 */
export function emptyRewriteResult(
  status: 'skipped-empty' | 'skipped-aborted',
  rawText: string,
): RewriteResult {
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

export type { Sentence, ScratchBlock } from '#internal/types';
export type { DegradeEvent, ParserManifest } from '#internal/narrative-parser-v2';
