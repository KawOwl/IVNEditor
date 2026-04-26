/**
 * RetrievalLogger —— 把 Memory.retrieve 的结果通过 callback 暴露出去
 *
 * ANN.1 用：每次 retrieve 后，把结果通过 logger 落到 turn_memory_retrievals
 * 表 + 通过 core event 广播给客户端。
 *
 * 设计选择：包一层 wrapper 而不是改 adapter：
 *  - 三个 adapter（legacy / llm-summarizer / mem0）的 retrieve 实现各异；
 *    在每个里调 callback 重复 3 次
 *  - logger 跟 turn / batchId 等运行时 context 强耦合（来自 game-session
 *    closure），adapter 不应该知道
 *  - 包一层让 adapter 保持 pure，hook 集中在 wrapper 里
 *
 * 失败契约：logger 抛错时 wrapper 吞掉 + console.warn（不能阻塞 retrieve）。
 */

import type { Memory, MemoryRetrieval } from '#internal/memory/types';

export type RetrievalSource = 'context-assembly' | 'tool-call';

export interface RetrievalLogContext {
  source: RetrievalSource;
  query: string;
  turn: number;
  batchId: string | null;
}

export type RetrievalLogger = (
  ctx: RetrievalLogContext,
  result: MemoryRetrieval,
) => void | Promise<void>;

export interface WrapMemoryOptions {
  logger: RetrievalLogger;
  /** 当前轮次提供器 —— 从 game-session 闭包里拿 */
  getTurn: () => number;
  /** 当前 batchId 提供器 —— context-assembly 早于 batch 分配时返回 null */
  getBatchId: () => string | null;
}

/**
 * 用 RetrievalLogger 包装一个 Memory 实例。
 * 返回的 wrapper 行为和原 Memory 完全一致，只多在 retrieve 后 fire-and-forget
 * 调 logger。其它方法（appendTurn / pin / snapshot / restore / ...）原样透传。
 *
 * @param defaultSource 'context-assembly' 或 'tool-call'。绝大多数 adapter
 *   的 retrieve 调用来自 context-assembler；query_memory tool 路径走的是
 *   独立 adapter（也调同一 wrap 实例的 retrieve），用 setSource 切换。
 *
 * 注意：当前 wrapper 假设所有 retrieve 都标 source='context-assembly'。
 * tool-call 路径如果将来需要区分，要用 wrapMemoryForToolCall 或 setSource
 * 暂时切换 —— Step 1 先不分，所有 retrieve 都标 context-assembly。
 */
export function wrapMemoryWithRetrievalLogger(
  inner: Memory,
  options: WrapMemoryOptions,
): Memory {
  const wrapped: Memory = {
    kind: inner.kind,

    appendTurn: (params) => inner.appendTurn(params),
    pin: (content, tags) => inner.pin(content, tags),
    getRecentAsMessages: (opts) => inner.getRecentAsMessages(opts),
    maybeCompact: () => inner.maybeCompact(),
    snapshot: () => inner.snapshot(),
    restore: (snap) => inner.restore(snap),
    reset: () => inner.reset(),

    async retrieve(query, hints) {
      const result = await inner.retrieve(query, hints);
      try {
        const ctx: RetrievalLogContext = {
          source: 'context-assembly',
          query,
          turn: options.getTurn(),
          batchId: options.getBatchId(),
        };
        // fire-and-forget；不等待，不阻塞 retrieve 返回
        Promise.resolve(options.logger(ctx, result)).catch((err) => {
          console.warn('[retrieval-logger] logger threw:', err);
        });
      } catch (err) {
        console.warn('[retrieval-logger] context capture failed:', err);
      }
      return result;
    },
  };
  return wrapped;
}
