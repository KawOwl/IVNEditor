/**
 * Narrative Retry-Main — 主入口（纯函数）
 *
 * 流程：
 *   1. skip 检查（abort / rawText 空白）
 *   2. 构造 messages（main path messages + assistant raw + nudge）
 *   3. trace span 开
 *   4. invoke LLM（systemPrompt + messages，**禁 tools** 由 caller 在 invoke 实现里保证）
 *   5. verifyParse(retryText) → sentenceCount > 0 ? ok : fallback
 *   6. fallback 路径可重试（默认 0 次）
 *   7. trace span 结
 *
 * 不依赖 SessionTracing / LLMClient / parser-v2 内部细节——所有接口通过
 * deps 注入，跟 rewriter 同形。
 */

import { buildRetryMainMessages } from '#internal/narrative-retry-main/prompt';
import {
  emptyRetryMainResult,
  type RetryMainDeps,
  type RetryMainFallbackReason,
  type RetryMainInput,
  type RetryMainResult,
  type RetryMainInvokeResult,
} from '#internal/narrative-retry-main/types';
import type { ParserVerifyResult } from '#internal/narrative-rewrite';

export async function retryMainNarrative(
  input: RetryMainInput,
  deps: RetryMainDeps,
): Promise<RetryMainResult> {
  if (input.abortSignal?.aborted) {
    return emptyRetryMainResult('skipped-aborted', input.rawText);
  }
  if (input.rawText.trim().length === 0) {
    return emptyRetryMainResult('skipped-empty', input.rawText);
  }

  const messages = buildRetryMainMessages(input.mainPathMessages, input.rawText);
  const maxRetries = Math.max(0, deps.maxRetries ?? 0);
  const startedAt = Date.now();

  let attempts = 0;
  let lastInvoke: RetryMainInvokeResult | null = null;
  let lastVerify: ParserVerifyResult | null = null;
  let lastFallbackReason: RetryMainFallbackReason | null = null;
  let cumulativeInput = 0;
  let cumulativeOutput = 0;
  let lastModel: string | null = null;

  while (attempts <= maxRetries) {
    attempts += 1;

    if (input.abortSignal?.aborted) {
      lastFallbackReason = 'aborted';
      break;
    }

    const span = deps.trace?.start({
      systemPrompt: input.mainPathSystemPrompt,
      messageCount: messages.length,
      rawTextLength: input.rawText.length,
    });

    let invoke: RetryMainInvokeResult;
    try {
      invoke = await deps.invoke({
        systemPrompt: input.mainPathSystemPrompt,
        messages,
        abortSignal: input.abortSignal,
      });
    } catch (err) {
      lastFallbackReason = (err as { name?: string })?.name === 'AbortError' ? 'aborted' : 'api-error';
      span?.end({
        error: err instanceof Error ? err.message : String(err),
        fallbackReason: lastFallbackReason,
      });
      // api-error 不重试（治不了 API/网络错误，徒增延迟）
      break;
    }

    lastInvoke = invoke;
    lastModel = invoke.model ?? lastModel;
    cumulativeInput += invoke.inputTokens ?? 0;
    cumulativeOutput += invoke.outputTokens ?? 0;

    // 二次 parser 校验
    const verify = deps.verifyParse(invoke.text, deps.parserManifest);
    lastVerify = verify;

    if (verify.sentenceCount > 0) {
      span?.end({
        text: invoke.text,
        finishReason: invoke.finishReason,
        inputTokens: invoke.inputTokens,
        outputTokens: invoke.outputTokens,
      });
      return {
        status: 'ok',
        text: invoke.text,
        verified: verify,
        attempts,
        fallbackReason: null,
        latencyMs: Date.now() - startedAt,
        model: invoke.model ?? null,
        inputTokens: cumulativeInput,
        outputTokens: cumulativeOutput,
      };
    }

    // sentenceCount === 0 → retry-main 也没救出正文
    lastFallbackReason = 'second-parse-failed';
    span?.end({
      text: invoke.text,
      finishReason: invoke.finishReason,
      inputTokens: invoke.inputTokens,
      outputTokens: invoke.outputTokens,
      fallbackReason: 'second-parse-failed',
    });
    // 进入重试 loop（如果还有 retry 配额）
  }

  // fallback：返回最后一次 retry 的 text（如果有）；否则 raw
  const fallbackText = lastInvoke?.text ?? input.rawText;
  return {
    status: 'fallback',
    text: fallbackText,
    verified: lastVerify,
    attempts,
    fallbackReason: lastFallbackReason ?? 'still-empty',
    latencyMs: Date.now() - startedAt,
    model: lastModel,
    inputTokens: cumulativeInput,
    outputTokens: cumulativeOutput,
  };
}
