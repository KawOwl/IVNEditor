/**
 * Narrative Rewrite — 主入口（纯函数）
 *
 * 流程：
 *   1. skip 检查（abort / 空 input）
 *   2. trace span 开
 *   3. invoke LLM（rewriter prompt + parser view + manifest）
 *   4. verifyParse(rewritten) → sentence count 0 ? fallback : ok
 *   5. fallback 路径：可重试（PR2+）；失败则 result.fallbackReason 标记
 *   6. trace span 结
 *
 * 不依赖 SessionTracing / LLMClient / parser-v2 内部细节——所有接口通过
 * deps 注入。让 harness 直接灌 trace 集合跑 eval。
 */

import {
  buildRewriteSystemPrompt,
  buildRewriteUserMessage,
} from '#internal/narrative-rewrite/prompt';
import {
  emptyRewriteResult,
  type RewriteDeps,
  type RewriteFallbackReason,
  type RewriteInput,
  type RewriteResult,
  type RewriteInvokeResult,
  type ParserVerifyResult,
} from '#internal/narrative-rewrite/types';

export async function rewriteNarrative(
  input: RewriteInput,
  deps: RewriteDeps,
): Promise<RewriteResult> {
  if (input.abortSignal?.aborted) {
    return emptyRewriteResult('skipped-aborted', input.rawText);
  }
  if (input.rawText.trim().length === 0) {
    return emptyRewriteResult('skipped-empty', input.rawText);
  }

  const systemPrompt = buildRewriteSystemPrompt();
  const userMessage = buildRewriteUserMessage(input);
  const maxRetries = Math.max(0, deps.maxRetries ?? 0);
  const startedAt = Date.now();

  let attempts = 0;
  let lastInvoke: RewriteInvokeResult | null = null;
  let lastVerify: ParserVerifyResult | null = null;
  let lastFallbackReason: RewriteFallbackReason | null = null;
  let cumulativeInput = 0;
  let cumulativeOutput = 0;
  let lastModel: string | null = null;

  // 至少跑 1 次（attempts=0 起），最多 1 + maxRetries 次
  while (attempts <= maxRetries) {
    attempts += 1;

    if (input.abortSignal?.aborted) {
      lastFallbackReason = 'aborted';
      break;
    }

    const span = deps.trace?.start({
      systemPrompt,
      userMessage,
      model: undefined, // invoke 返回时再补上
    });

    let invoke: RewriteInvokeResult;
    try {
      invoke = await deps.invoke({
        systemPrompt,
        userMessage,
        abortSignal: input.abortSignal,
      });
    } catch (err) {
      lastFallbackReason = (err as { name?: string })?.name === 'AbortError' ? 'aborted' : 'api-error';
      span?.end({
        error: err instanceof Error ? err.message : String(err),
        fallbackReason: lastFallbackReason,
      });
      // api-error 不重试（重试通常治不了 API/网络错误，且会延迟）
      break;
    }

    lastInvoke = invoke;
    lastModel = invoke.model ?? lastModel;
    cumulativeInput += invoke.inputTokens ?? 0;
    cumulativeOutput += invoke.outputTokens ?? 0;

    // 二次校验
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

    // sentenceCount === 0 → 二次校验失败
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

  // fallback：返回最后一次 rewrite 的 text（如果有）；否则 raw
  const fallbackText = lastInvoke?.text ?? input.rawText;
  return {
    status: 'fallback',
    text: fallbackText,
    verified: lastVerify,
    attempts,
    fallbackReason: lastFallbackReason ?? 'rewrite-still-empty',
    latencyMs: Date.now() - startedAt,
    model: lastModel,
    inputTokens: cumulativeInput,
    outputTokens: cumulativeOutput,
  };
}
