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
 * - noop：完全不插入任何记忆，评测零基线
 * - legacy（默认）：截断拼接"压缩"，无外部依赖
 * - llm-summarizer：真 LLM 摘要，需要 llmClient
 * - mem0（Phase 3）：mem0 云端长期记忆；API key 由宿主运行时注入
 */

import type { Memory, CreateMemoryOptions } from '#internal/memory/types';
import { NoopMemory } from '#internal/memory/noop/adapter';
import { LegacyMemory } from '#internal/memory/legacy/manager';
import { truncatingCompressFn } from '#internal/memory/legacy/compress';
import { LLMSummarizerMemory } from '#internal/memory/llm-summarizer/manager';
import { Mem0Memory } from '#internal/memory/mem0/adapter';
import { MemoraxMemory } from '#internal/memory/memorax/adapter';

export async function createMemory(options: CreateMemoryOptions): Promise<Memory> {
  const kind = options.config.provider ?? 'legacy';

  switch (kind) {
    case 'noop':
      return new NoopMemory(options.config, options.coreEventReader);

    case 'legacy':
      return new LegacyMemory(options.config, truncatingCompressFn, options.coreEventReader);

    case 'llm-summarizer':
      if (!options.llmClient) {
        throw new Error(
          'Memory provider "llm-summarizer" requires llmClient (game-session 必须在 createMemory 前构造 LLMClient)',
        );
      }
      return new LLMSummarizerMemory(options.config, options.llmClient, options.coreEventReader);

    case 'mem0':
      {
        const apiKey =
          (options.config.providerOptions?.apiKey as string | undefined) ??
          options.mem0ApiKey;
        if (!apiKey) {
          throw new Error(
            'Memory provider "mem0" requires mem0ApiKey or providerOptions.apiKey',
          );
        }
        return new Mem0Memory(options.scope, options.config, apiKey);
      }

    case 'memorax':
      {
        const cfg = options.memoraxConfig;
        if (!cfg?.baseUrl || !cfg?.apiKey) {
          throw new Error(
            'Memory provider "memorax" requires memoraxConfig.{baseUrl,apiKey} (host runtime must inject from env)',
          );
        }
        return new MemoraxMemory(options.scope, options.config, {
          baseUrl: cfg.baseUrl,
          apiKey: cfg.apiKey,
          appId: cfg.appId,
        });
      }

    default:
      throw new Error(`Unknown memory provider: ${String(kind)}`);
  }
}
