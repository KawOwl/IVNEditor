/**
 * Director Agent - Translates mechanical GOAP actions into literary narrative.
 * Produces scene outputs with dialogue, emotions, and visual directions.
 * Uses generateText + manual JSON parsing for reliable DeepSeek integration.
 */

import { generateText } from 'ai';
import { z } from 'zod';
import { getChatModel } from './deepseek';
import { extractJSON } from './utils';
import { SceneOutputSchema } from '../memory/schemas';
import type { GOAPAction, Goal5W1H, CorePersona, WorldEvent, SceneOutput } from '../memory/schemas';

export interface DirectorInput {
  characterPersona: CorePersona;
  currentGoal: Goal5W1H;
  action: GOAPAction;
  worldEvent?: WorldEvent;
  interrupted?: boolean;
}

export interface DirectorResult {
  scenes: SceneOutput[];
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

const ScenesSchema = z.object({ scenes: z.array(SceneOutputSchema) });

/**
 * Generate narrative scenes for a character action.
 */
export async function runDirector(input: DirectorInput): Promise<DirectorResult> {
  const startTime = Date.now();

  const eventContext = input.worldEvent
    ? `\n⚠ 突发事件：${input.worldEvent.name} - ${input.worldEvent.description}`
    : '';

  const interruptContext = input.interrupted
    ? '\n注意：角色的原计划被突发事件打断，需要表现出被中断的反应。'
    : '';

  const system = `你是一位互动小说的叙事导演。你需要将角色的机械动作翻译为富有文学性的对话和环境描写。

角色信息：
- 名字：${input.characterPersona.name}
- 说话风格：${input.characterPersona.speechStyle}
- 背景：${input.characterPersona.background}

当前目标：${input.currentGoal.what}
原因：${input.currentGoal.why}${eventContext}${interruptContext}`;

  const { text, usage } = await generateText({
    model: getChatModel(),
    system,
    prompt: `角色正在执行动作："${input.action.name}" - ${input.action.description}

请将这个动作转化为1-3个叙事场景片段。严格输出以下JSON格式（不要添加任何其他内容）：
{
  "scenes": [
    {
      "speaker": "角色ID或null（null表示旁白）",
      "dialogue": "对话或旁白文本",
      "emotion": "neutral/happy/sad/angry/surprised/fearful/determined/suspicious",
      "narration": "环境描写/动作描述（可选）"
    }
  ]
}

要求：
1. 对话要符合角色的说话风格和性格
2. 加入适当的环境描写和动作描述
3. emotion使用：neutral/happy/sad/angry/surprised/fearful/determined/suspicious
4. speaker为null时表示旁白

请用中文创作，仅输出JSON。`,
  });

  const durationMs = Date.now() - startTime;

  // Parse and validate
  const rawJson = extractJSON(text);
  const parsed = JSON.parse(rawJson);
  const result = ScenesSchema.parse(parsed);

  return {
    scenes: result.scenes,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    durationMs,
  };
}
