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
import { ParallelMemory, type ParallelMemoryChild } from '#internal/memory/parallel/adapter';

/** parallel provider 的 children，缺省 memorax 优先 mem0 兜底 */
const DEFAULT_PARALLEL_CHILDREN = ['memorax', 'mem0'] as const;
type ParallelChildName = 'mem0' | 'memorax';
const PARALLEL_CHILD_NAMES: ReadonlySet<string> = new Set(['mem0', 'memorax']);

export async function createMemory(options: CreateMemoryOptions): Promise<Memory> {
  const kind = options.config.provider ?? 'legacy';

  switch (kind) {
    case 'noop':
      // noop adapter ignores deletionFilter（retrieve 永远空）
      return new NoopMemory(options.config, options.coreEventReader);

    case 'legacy':
      return new LegacyMemory(options.config, truncatingCompressFn, options.coreEventReader, options.deletionFilter);

    case 'llm-summarizer':
      if (!options.llmClient) {
        throw new Error(
          'Memory provider "llm-summarizer" requires llmClient (game-session 必须在 createMemory 前构造 LLMClient)',
        );
      }
      return new LLMSummarizerMemory(options.config, options.llmClient, options.coreEventReader, options.deletionFilter);

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
        return new Mem0Memory(options.scope, options.config, apiKey, options.deletionFilter);
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
        }, options.deletionFilter);
      }

    case 'parallel':
      {
        const requested = (options.config.providerOptions?.children as
          | readonly string[]
          | undefined) ?? DEFAULT_PARALLEL_CHILDREN;
        const seen = new Set<string>();
        const childNames: ParallelChildName[] = [];
        for (const name of requested) {
          if (!PARALLEL_CHILD_NAMES.has(name)) {
            throw new Error(
              `parallel.providerOptions.children: unknown child "${name}". Allowed: mem0, memorax.`,
            );
          }
          if (seen.has(name)) continue;
          seen.add(name);
          childNames.push(name as ParallelChildName);
        }
        if (childNames.length === 0) {
          throw new Error('parallel.providerOptions.children must list at least one child');
        }

        // 递归用 createMemory 构造每个 child（按 name override provider）。
        // providerOptions 不递归传 —— children 字段是 parallel 自己的扩展。
        const childOptions = { ...options, config: { ...options.config, providerOptions: undefined } };
        const children: ParallelMemoryChild[] = [];
        for (const name of childNames) {
          const memory = await createMemory({
            ...childOptions,
            config: { ...childOptions.config, provider: name },
          });
          children.push({ name, memory });
        }
        return new ParallelMemory(options.config, children, options.coreEventReader);
      }

    default:
      throw new Error(`Unknown memory provider: ${String(kind)}`);
  }
}
