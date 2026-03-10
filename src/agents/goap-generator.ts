/**
 * GOAP Generator Agent — dynamically generates new GOAP actions
 * based on player input when existing actions can't cover the intent.
 */

import { generateText } from 'ai';
import { getChatModel } from './deepseek';
import { extractJSON } from './utils';
import { GOAPActionSchema } from '../memory/schemas';
import type { GOAPAction, Goal5W1H } from '../memory/schemas';

export interface GoapGeneratorResult {
  action: GOAPAction | null;
  reason: string;
  durationMs: number;
}

/**
 * Attempt to generate a new GOAP action based on player intent.
 * Returns null if existing actions already cover the player's intent.
 */
export async function generateGoapAction(
  playerMessage: string,
  existingActions: GOAPAction[],
  currentGoal: Goal5W1H | null,
): Promise<GoapGeneratorResult> {
  const startTime = Date.now();

  const actionList = existingActions
    .map((a) => `- ${a.id}: ${a.name} (${a.description}) → effects: ${JSON.stringify(a.effects)}`)
    .join('\n');

  const goalContext = currentGoal
    ? `当前目标: ${currentGoal.what} (${currentGoal.why})`
    : '无当前目标';

  const system = `你是一个GOAP动作生成器。分析玩家的输入意图，判断现有动作库是否已能满足，如果不能则生成一个新的GOAP动作。

现有动作库：
${actionList}

${goalContext}

规则：
1. 如果玩家意图可以用现有动作组合实现，输出 {"needed": false, "reason": "说明为什么现有动作够用"}
2. 如果需要新动作，输出：
{
  "needed": true,
  "reason": "说明为什么需要新动作",
  "action": {
    "id": "英文小写连字符ID",
    "name": "中文动作名",
    "preconditions": {"atDestination": true},
    "effects": {"效果key": true},
    "cost": 1到5,
    "timeCost": 5到60,
    "description": "动作描述"
  }
}

注意：
- preconditions 和 effects 使用布尔值
- 新动作的 effects 中的 key 应该语义清晰（如 hasClue, isHidden, hasAlly 等）
- cost 和 timeCost 要合理
- 只输出JSON，请以json格式输出`;

  const { text } = await generateText({
    model: getChatModel(),
    system,
    prompt: `玩家输入："${playerMessage}"

请分析是否需要生成新的GOAP动作。仅输出JSON。`,
  });

  const durationMs = Date.now() - startTime;

  try {
    const rawJson = extractJSON(text);
    const parsed = JSON.parse(rawJson);

    if (!parsed.needed) {
      return {
        action: null,
        reason: parsed.reason || '现有动作已满足',
        durationMs,
      };
    }

    // Validate the generated action
    const action = GOAPActionSchema.parse(parsed.action);

    // Check for duplicate IDs
    if (existingActions.some((a) => a.id === action.id)) {
      return {
        action: null,
        reason: `动作 ${action.id} 已存在`,
        durationMs,
      };
    }

    return { action, reason: parsed.reason || '', durationMs };
  } catch (err) {
    console.warn('Failed to parse GOAP generator response:', err);
    return {
      action: null,
      reason: `解析失败: ${err instanceof Error ? err.message : String(err)}`,
      durationMs,
    };
  }
}
