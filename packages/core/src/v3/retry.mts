export type RetryOptions = {
  readonly maxAttempts: number;
  readonly backoffMs: (attempt: number) => number;
  readonly shouldRetry?: (err: unknown) => boolean;
};

// 迁移破口：未来换 Effect.retry + Schedule.exponential。
// 见 docs/refactor/v3-effect-migration-plan.md。
export const withRetry = async <T,>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<T> => {
  let attempt = 0;
  let lastErr: unknown;
  while (attempt < opts.maxAttempts) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (opts.shouldRetry && !opts.shouldRetry(e)) throw e;
      attempt++;
      if (attempt >= opts.maxAttempts) break;
      await new Promise((r) => setTimeout(r, opts.backoffMs(attempt)));
    }
  }
  throw lastErr;
};

export const exponentialBackoff =
  (baseMs: number, factor = 2, maxMs = 30_000) =>
  (attempt: number): number =>
    Math.min(maxMs, baseMs * Math.pow(factor, attempt - 1));
