/**
 * Injection Rule Generator Agent — Step 2.5
 *
 * Generates InjectionRule[] from conditional patterns in documents.
 * E.g. "当玩家进入共鸣池时，参考以下设定..." → condition + segment ref.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import type { UploadedDocument, InjectionRuleResult } from './types';
import type { InjectionRule, PromptSegment } from '../types';

// ============================================================================
// Extraction Prompt
// ============================================================================

const INJECTION_RULE_SYSTEM = `你是一个互动小说引擎的注入规则分析助手。
你的任务是从 GM 提示词中发现条件性内容注入的模式，并生成注入规则。

注入规则描述了"在什么条件下，哪些 Prompt 片段应该被激活/注入到上下文中"。

常见模式：
1. "当玩家进入 [地点] 时，使用以下设定..." → condition: "current_area == '[地点]'"
2. "当 [变量] 达到 [值] 时，改变行为..." → condition: "[变量] >= [值]"
3. "如果玩家已经探索过 [地点]..." → condition: "explored_areas.includes('[地点]')"
4. "在第 [N] 阶段之后..." → condition: "phase >= [N]"

输出每条规则的：
- description: 自然语言描述（中文，编剧可见）
- condition: JavaScript 表达式（引用状态变量）
- segmentIds: 关联的 PromptSegment ID 列表（如果能对应上已有的 segment）
- priority: 优先级（0=最高）`;

const ruleSchema = z.object({
  rules: z.array(z.object({
    description: z.string(),
    condition: z.string(),
    segmentIds: z.array(z.string()),
    priority: z.number(),
  })),
  reasoning: z.string(),
});

// ============================================================================
// Generate Injection Rules
// ============================================================================

export async function generateInjectionRules(
  documents: UploadedDocument[],
  segments: PromptSegment[],
  model: LanguageModel,
): Promise<InjectionRuleResult> {
  const gmDocs = documents.filter((d) => d.role === 'gm_prompt');
  const allDocs = gmDocs.length > 0 ? gmDocs : documents;

  const docContent = allDocs
    .map((d) => `--- ${d.filename} ---\n${d.content}`)
    .join('\n\n');

  const segmentList = segments
    .map((s) => `- ${s.id}: "${s.label}" (type: ${s.type}, role: ${s.role})`)
    .join('\n');

  const result = await generateObject({
    model,
    system: INJECTION_RULE_SYSTEM,
    prompt: `已有的 PromptSegment 列表：\n${segmentList}\n\n请从以下文档中提取注入规则：\n\n${docContent}`,
    schema: ruleSchema,
  });

  const rules: InjectionRule[] = result.object.rules.map((r) => ({
    description: r.description,
    condition: r.condition,
  }));

  return {
    rules,
    reasoning: result.object.reasoning,
  };
}
