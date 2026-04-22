/**
 * createMemory —— Memory adapter 的工厂
 *
 * 根据 MemoryConfig.provider 分发给具体实现。让 game-session 不直接
 * import adapter 类，换实现只改配置。
 *
 * 各 adapter 是**平行独立**的（不继承），共享的只有 Memory interface。
 * 换 provider 时 snapshot 不可互通（kind 字段自隔离）—— 这是 opaque
 * snapshot 的预期契约。
 *
 * - legacy（默认）：截断拼接"压缩"，无外部依赖
 * - llm-summarizer：真 LLM 摘要，需要 llmClient
 * - mem0（Phase 3）：mem0 托管向量检索
 */

import type { Memory, CreateMemoryOptions } from './types';
import { LegacyMemory } from './legacy/manager';
import { truncatingCompressFn } from './legacy/compress';
import { LLMSummarizerMemory } from './llm-summarizer/manager';

export async function createMemory(options: CreateMemoryOptions): Promise<Memory> {
  const kind = options.config.provider ?? 'legacy';

  switch (kind) {
    case 'legacy':
      return new LegacyMemory(options.config, truncatingCompressFn);

    case 'llm-summarizer':
      if (!options.llmClient) {
        throw new Error(
          'Memory provider "llm-summarizer" requires llmClient (game-session 必须在 createMemory 前构造 LLMClient)',
        );
      }
      return new LLMSummarizerMemory(options.config, options.llmClient);

    case 'mem0':
      // Phase 3
      throw new Error('Memory provider "mem0" not implemented yet (Phase 3)');

    default:
      throw new Error(`Unknown memory provider: ${String(kind)}`);
  }
}
