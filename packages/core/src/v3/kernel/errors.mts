// Tagged error classes。`_tag` 字段是 Effect Data.TaggedError 迁移锚点。
// 见 docs/refactor/v3-effect-migration-plan.md。

export class LLMRateLimitError extends Error {
  readonly _tag = 'LLMRateLimit' as const;
  constructor(
    public readonly retryAfterMs: number,
    message?: string,
  ) {
    super(message ?? `LLM rate limited; retry after ${retryAfterMs}ms`);
    this.name = 'LLMRateLimitError';
  }
}

export class LLMAuthError extends Error {
  readonly _tag = 'LLMAuth' as const;
  constructor(message: string) {
    super(message);
    this.name = 'LLMAuthError';
  }
}

export class NetworkError extends Error {
  readonly _tag = 'Network' as const;
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'NetworkError';
  }
}

export class ToolExecutionError extends Error {
  readonly _tag = 'ToolExecution' as const;
  constructor(
    public readonly callId: string,
    public readonly toolName: string,
    public readonly originalCause: unknown,
  ) {
    super(`tool ${toolName} (${callId}) failed: ${String(originalCause)}`);
    this.name = 'ToolExecutionError';
  }
}

export type KernelError =
  | LLMRateLimitError
  | LLMAuthError
  | NetworkError
  | ToolExecutionError;
