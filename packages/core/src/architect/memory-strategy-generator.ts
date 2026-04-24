/**
 * Memory Strategy Generator Agent — Step 2.7
 *
 * Extracts memory strategy configuration from documents:
 *   - Compression hints (what to preserve during compression)
 *   - Budget and threshold recommendations
 *
 * 跨章继承字段已删除：对应的 chapter-transition 运行时被确认为死代码
 * 且在记忆模块重构中 memory 已脱离章节语义，Architect 不再生成 inherit/exclude。
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import type { UploadedDocument, MemoryStrategyResult } from '#internal/architect/types';
import type { MemoryConfig } from '#internal/types';

// ============================================================================
// Extraction Prompt
// ============================================================================

const MEMORY_STRATEGY_SYSTEM = `你是一个互动小说引擎的记忆策略分析助手。
你的任务是从编剧文档中提取记忆管理策略。

需要提取的信息：
1. **压缩提示**：编剧希望在压缩记忆时保留哪些关键信息？
   - 例如："女孩说过的每一个词都很重要" → 压缩时必须保留对话细节
   - 例如："玩家的关键选择必须记住" → 压缩时保留选择记录
2. **预算建议**：根据文档复杂度建议 token 预算
   - contextBudget: 总上下文预算（推荐 8000-32000）
   - compressionThreshold: 压缩触发阈值（通常为 budget 的 60-80%）
   - recencyWindow: 保留最近几轮原文（推荐 3-8）`;

const strategySchema = z.object({
  contextBudget: z.number(),
  compressionThreshold: z.number(),
  recencyWindow: z.number(),
  compressionHints: z.string(),
  reasoning: z.string(),
});

// ============================================================================
// Generate Memory Strategy
// ============================================================================

export async function generateMemoryStrategy(
  documents: UploadedDocument[],
  model: LanguageModel,
): Promise<MemoryStrategyResult> {
  const docContent = documents
    .map((d) => `--- ${d.filename} (${d.role}) ---\n${d.content}`)
    .join('\n\n');

  const result = await generateObject({
    model,
    system: MEMORY_STRATEGY_SYSTEM,
    prompt: `请从以下文档中提取记忆管理策略：\n\n${docContent}`,
    schema: strategySchema,
  });

  const config: MemoryConfig = {
    contextBudget: result.object.contextBudget,
    compressionThreshold: result.object.compressionThreshold,
    recencyWindow: result.object.recencyWindow,
    compressionHints: result.object.compressionHints,
  };

  return {
    config,
    reasoning: result.object.reasoning,
  };
}
