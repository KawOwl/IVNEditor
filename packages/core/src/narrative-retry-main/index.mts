/**
 * Narrative Retry-Main 公开 API
 *
 * 入口：retryMainNarrative(input, deps) — 纯函数
 * 类型：RetryMainInput / RetryMainResult / RetryMainDeps / ...
 */

export { retryMainNarrative } from '#internal/narrative-retry-main/retry-main';
export {
  buildRetryMainMessages,
  RETRY_MAIN_NUDGE_CONTENT,
} from '#internal/narrative-retry-main/prompt';
export { emptyRetryMainResult } from '#internal/narrative-retry-main/types';
export type {
  RetryMainInput,
  RetryMainInvoke,
  RetryMainInvokeResult,
  RetryMainTraceHook,
  RetryMainTraceSpan,
  RetryMainDeps,
  RetryMainFallbackReason,
  RetryMainStatus,
  RetryMainResult,
} from '#internal/narrative-retry-main/types';
