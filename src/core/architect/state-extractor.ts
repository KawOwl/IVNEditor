/**
 * State Extractor Agent — Step 2.2
 *
 * Analyzes GM prompt documents to extract StateSchema:
 * variable names, types, initial values, descriptions.
 *
 * Looks for patterns like INTERNAL_STATE definitions in GM prompts.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import type { UploadedDocument, StateExtractionResult } from './types';
import type { StateSchema } from '../types';

// ============================================================================
// Extraction Prompt
// ============================================================================

const STATE_EXTRACTION_SYSTEM = `你是一个互动小说引擎的状态分析助手。
你的任务是从 GM 提示词文档中提取所有需要追踪的状态变量。

常见的状态变量来源：
1. 明确标记的 INTERNAL_STATE / 内部状态 定义区域
2. "GM 需要追踪/更新/维护" 的变量描述
3. 条件判断中引用的变量（如 "当信任等级达到3时..."）
4. 游戏机制中隐含的计数器、标志位、列表

输出每个变量的：
- name: 变量名（英文 snake_case）
- type: 数据类型（string / number / boolean / string[] / number[]）
- defaultValue: 初始值
- description: 中文描述
- source: 从文档哪个部分提取的`;

const stateSchema = z.object({
  variables: z.array(z.object({
    name: z.string(),
    type: z.enum(['string', 'number', 'boolean', 'array', 'object']),
    defaultValue: z.unknown(),
    description: z.string(),
    source: z.string(),
  })),
  reasoning: z.string(),
});

// ============================================================================
// Extract State Variables
// ============================================================================

export async function extractStateVariables(
  documents: UploadedDocument[],
  model: LanguageModel,
): Promise<StateExtractionResult> {
  // Filter to GM prompt documents (primary source for state variables)
  const gmDocs = documents.filter((d) => d.role === 'gm_prompt');
  const allDocs = gmDocs.length > 0 ? gmDocs : documents;

  const docContent = allDocs
    .map((d) => `--- ${d.filename} ---\n${d.content}`)
    .join('\n\n');

  const result = await generateObject({
    model,
    system: STATE_EXTRACTION_SYSTEM,
    prompt: `请从以下文档中提取所有状态变量：\n\n${docContent}`,
    schema: stateSchema,
  });

  const schema: StateSchema = {
    variables: result.object.variables.map((v) => ({
      name: v.name,
      type: v.type,
      initial: v.defaultValue,
      description: v.description,
      updatedBy: 'llm' as const,
    })),
  };

  return {
    schema,
    reasoning: result.object.reasoning,
  };
}
