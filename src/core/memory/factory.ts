/**
 * createMemory —— Memory adapter 的工厂
 *
 * 根据 MemoryConfig.provider 分发给具体实现。让 game-session 不直接
 * import adapter 类，换实现只改配置。
 *
 * Phase 1 只支持 legacy（默认）。Phase 2 加 llm-summarizer，Phase 3 加 mem0。
 */

import type { Memory, CreateMemoryOptions } from './types';
import { LegacyMemory } from './legacy/manager';
import { truncatingCompressFn } from './legacy/compress';

export async function createMemory(options: CreateMemoryOptions): Promise<Memory> {
  const kind = options.config.provider ?? 'legacy';

  switch (kind) {
    case 'legacy':
      return new LegacyMemory(options.config, truncatingCompressFn);

    case 'llm-summarizer':
      // Phase 2
      throw new Error('Memory provider "llm-summarizer" not implemented yet (Phase 2)');

    case 'mem0':
      // Phase 3
      throw new Error('Memory provider "mem0" not implemented yet (Phase 3)');

    default:
      throw new Error(`Unknown memory provider: ${String(kind)}`);
  }
}
