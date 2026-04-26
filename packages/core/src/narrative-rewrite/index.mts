/**
 * Narrative Rewrite 公开 API
 *
 * 入口：rewriteNarrative(input, deps) — 纯函数
 * 类型：RewriteInput / RewriteResult / RewriteDeps / ...
 */

export { rewriteNarrative } from '#internal/narrative-rewrite/rewriter';
export {
  buildRewriteSystemPrompt,
  buildRewriteUserMessage,
} from '#internal/narrative-rewrite/prompt';
export {
  summarizeManifest,
  emptyRewriteResult,
} from '#internal/narrative-rewrite/types';
export type {
  ParserView,
  ManifestSummary,
  RewriteInput,
  RewriteInvoke,
  RewriteInvokeResult,
  RewriteTraceHook,
  RewriteTraceSpan,
  RewriteDeps,
  ParserVerifyResult,
  RewriteFallbackReason,
  RewriteStatus,
  RewriteResult,
} from '#internal/narrative-rewrite/types';
