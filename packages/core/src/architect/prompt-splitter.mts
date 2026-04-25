/**
 * Prompt Splitter Agent — Step 2.4
 *
 * Splits large documents into PromptSegment[] with:
 *   - Semantic boundaries (rules, scene-specific, conditional content)
 *   - content/logic type classification
 *   - contentHash generation for change detection
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import type { UploadedDocument, PromptSplitResult } from '#internal/architect/types';
import type { PromptSegment } from '#internal/types';
import { estimateTokens } from '#internal/tokens';

// ============================================================================
// Hash Helper
// ============================================================================

function hashContent(content: string): string {
  // Simple djb2-style hash — deterministic, fast, good enough for change detection
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) & 0xffffffff;
  }
  return hash.toString(36);
}

// ============================================================================
// Extraction Prompt
// ============================================================================

const PROMPT_SPLIT_SYSTEM = `你是一个互动小说引擎的 Prompt 拆分助手。
你的任务是将编剧的大文档智能拆分为可管理的 Prompt 片段（PromptSegment）。

拆分原则：
1. **按语义和功能边界拆分**：通用规范、章节特定内容、场景设定、条件性内容应分开
2. **粒度适中**：每个片段应有独立的语义意义，但不要拆得太碎（不小于 100 字）
3. **标注类型**：
   - content: 纯内容片段（角色设定、世界观、写作风格等）
   - logic: 包含游戏逻辑控制的片段（阶段地图、条件判断、状态更新规则等）
4. **标注角色**：
   - system: 系统级提示（始终存在于上下文中）
   - context: 上下文片段（按条件注入）
5. **标注优先级**：0=最高（核心规则），数字越大优先级越低
6. **保持原文完整性**：拆分后的片段拼接应等于原文，不要丢失内容

输出每个片段的：
- id: 唯一标识符（格式：seg-{序号}）
- label: 片段名称（中文描述）
- content: 片段内容（原文）
- type: content 或 logic
- role: system 或 context
- priority: 优先级数字
- sourceDoc: 来源文档文件名`;

const splitSchema = z.object({
  segments: z.array(z.object({
    id: z.string(),
    label: z.string(),
    content: z.string(),
    type: z.enum(['content', 'logic']),
    role: z.enum(['system', 'context', 'draft']),
    priority: z.number(),
    sourceDoc: z.string(),
  })),
  reasoning: z.string(),
});

// ============================================================================
// Split Prompts
// ============================================================================

export async function splitPrompts(
  documents: UploadedDocument[],
  model: LanguageModel,
): Promise<PromptSplitResult> {
  const docContent = documents
    .map((d) => `--- ${d.filename} (${d.role}) ---\n${d.content}`)
    .join('\n\n');

  const result = await generateObject({
    model,
    system: PROMPT_SPLIT_SYSTEM,
    prompt: `请将以下文档拆分为 PromptSegment：\n\n${docContent}`,
    schema: splitSchema,
  });

  const segments: PromptSegment[] = result.object.segments.map((s) => ({
    id: s.id,
    label: s.label,
    content: s.content,
    contentHash: hashContent(s.content),
    type: s.type,
    sourceDoc: s.sourceDoc,
    role: s.role,
    priority: s.priority,
    tokenCount: estimateTokens(s.content),
  }));

  return {
    segments,
    reasoning: result.object.reasoning,
  };
}

/** Recompute contentHash for a segment after editing */
export function rehashSegment(segment: PromptSegment): PromptSegment {
  return { ...segment, contentHash: hashContent(segment.content) };
}
