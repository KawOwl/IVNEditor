/**
 * Cognition Agent - 5W1H reasoning for character decision-making.
 * Uses DeepSeek chat to generate structured 5W1H goals.
 * Uses generateText + manual JSON parsing for reliable DeepSeek integration.
 */

import { generateText } from 'ai';
import { getChatModel } from './deepseek';
import { extractJSON } from './utils';
import { Goal5W1HSchema } from '../memory/schemas';
import type { AssembleResult } from '../memory/context-engine';
import type { Goal5W1H } from '../memory/schemas';

export interface CognitionResult {
  goal: Goal5W1H;
  rawResponse: string;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

/**
 * Run 5W1H cognitive reasoning for a character.
 * Takes assembled context from ContextEngine and returns a structured goal.
 */
export async function runCognition(
  assembledContext: AssembleResult,
): Promise<CognitionResult> {
  const startTime = Date.now();

  const systemMessage = assembledContext.messages.find(
    (m) => m.role === 'system',
  );
  const contextContent = systemMessage?.content ?? '';

  const { text, usage } = await generateText({
    model: getChatModel(),
    system: contextContent,
    prompt: `基于你当前的记忆、人格、目标和世界状态，运用5W1H分析法决定你的下一个短期行动目标。

你必须严格输出以下JSON格式（不要添加任何其他内容）：
{
  "who": ["角色ID列表"],
  "what": "具体的、可执行的行动",
  "where": "地点ID（必须是可用地点之一）",
  "when": "执行时机或前置条件",
  "why": "为什么这个行动有助于长期目标或响应当前事件",
  "how": ["原子步骤1", "原子步骤2", "原子步骤3"]
}

要求：
1. "what" 必须是具体的、可执行的行动（不是抽象的想法）
2. "why" 必须明确说明这个行动如何推进你的长期目标，或如何回应当前的紧急事件
3. "how" 必须列出2-4个具体的原子步骤
4. "where" 必须是可用地点列表中的一个
5. "who" 列出涉及的角色ID
6. "when" 说明执行时机

请用中文回答，仅输出JSON。`,
  });

  const durationMs = Date.now() - startTime;

  // Parse and validate with Zod (with safe defaults for missing fields)
  const rawJson = extractJSON(text);
  const parsed = JSON.parse(rawJson);
  const goal = Goal5W1HSchema.parse(parsed);

  return {
    goal,
    rawResponse: text,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    durationMs,
  };
}
