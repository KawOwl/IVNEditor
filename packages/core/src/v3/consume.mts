import type { KernelEvent } from '#internal/v3/kernel/types';

export type Handlers<S> = {
  readonly [K in KernelEvent['type']]?: (
    event: Extract<KernelEvent, { type: K }>,
    state: S,
  ) => S | Promise<S>;
};

// 三 caller (CLI REPL / eval / VN orchestrator) 共享 stream 消费形态。
// 迁移破口：未来换 Stream.runForEach + Effect.runPromise。
// 见 docs/refactor/v3-effect-migration-plan.md。
export const consumeKernel = async <S,>(
  stream: AsyncIterable<KernelEvent>,
  handlers: Handlers<S>,
  initial: S,
): Promise<S> => {
  let state = initial;
  for await (const ev of stream) {
    const handler = handlers[ev.type] as
      | ((e: typeof ev, s: S) => S | Promise<S>)
      | undefined;
    if (handler) state = await handler(ev, state);
  }
  return state;
};

// Eval batch / debug 模式：收尽所有事件 → 数组。
// 迁移破口：未来换 Stream.runCollect。
// 见 docs/refactor/v3-effect-migration-plan.md。
export const collectAllEvents = async (
  stream: AsyncIterable<KernelEvent>,
): Promise<readonly KernelEvent[]> => {
  const events: KernelEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
};
