/**
 * Document Classifier — Step 2.1
 *
 * Classifies uploaded documents by role (gm_prompt, world_data, etc.)
 * using LLM analysis of filename and content.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import type { UploadedDocument, ClassificationResult, DocumentRole } from './types';
import { estimateTokens } from '../tokens';

// ============================================================================
// Classification Prompt
// ============================================================================

const CLASSIFICATION_SYSTEM = `你是一个互动小说引擎的文档分析助手。
你的任务是根据文件名和内容，判断每个文档在互动小说中的角色。

可选角色：
- gm_prompt: GM 提示词（包含游戏规则、阶段地图、状态定义等核心指令）
- pc_prompt: PC 提示词（玩家角色的行为指引）
- world_data: 世界观资料（时间线、历史、设定）
- location_data: 场景/地点设定（特定地点的详细描述）
- character_data: 角色设定（角色性格、背景、行为模式）
- rules: 游戏规则/机制说明（独立的规则文档）
- other: 不属于以上任何类别

如果文档明确属于某个章节，请标注章节信息。`;

const classificationSchema = z.object({
  classifications: z.array(z.object({
    documentId: z.string(),
    role: z.enum(['gm_prompt', 'pc_prompt', 'world_data', 'location_data', 'character_data', 'rules', 'other']),
    chapter: z.string().optional(),
    confidence: z.number().min(0).max(1),
    reasoning: z.string(),
  })),
});

// ============================================================================
// Classify Documents
// ============================================================================

export async function classifyDocuments(
  documents: Array<{ filename: string; content: string }>,
  model: LanguageModel,
): Promise<{ documents: UploadedDocument[]; classifications: ClassificationResult[] }> {
  // Build document summaries for classification
  const docSummaries = documents.map((doc, i) => {
    const preview = doc.content.slice(0, 2000);
    return `--- 文档 ${i + 1} ---
文件名: ${doc.filename}
内容预览 (前2000字):
${preview}
${doc.content.length > 2000 ? `\n[...省略 ${doc.content.length - 2000} 字]` : ''}`;
  });

  const result = await generateObject({
    model,
    system: CLASSIFICATION_SYSTEM,
    prompt: `请分类以下 ${documents.length} 个文档：\n\n${docSummaries.join('\n\n')}`,
    schema: classificationSchema,
  });

  const uploadedDocs: UploadedDocument[] = documents.map((doc, i) => ({
    id: `doc-${i}`,
    filename: doc.filename,
    content: doc.content,
    role: (result.object.classifications[i]?.role ?? 'other') as DocumentRole,
    chapter: result.object.classifications[i]?.chapter,
    tokenCount: estimateTokens(doc.content),
  }));

  const classifications: ClassificationResult[] = result.object.classifications.map((c, i) => ({
    documentId: `doc-${i}`,
    role: c.role as DocumentRole,
    chapter: c.chapter,
    confidence: c.confidence,
    reasoning: c.reasoning,
  }));

  return { documents: uploadedDocs, classifications };
}

// ============================================================================
// Manual reclassification (no LLM needed)
// ============================================================================

export function reclassifyDocument(
  doc: UploadedDocument,
  newRole: DocumentRole,
  chapter?: string,
): UploadedDocument {
  return { ...doc, role: newRole, chapter };
}
