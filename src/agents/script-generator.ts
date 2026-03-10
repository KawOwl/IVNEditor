/**
 * Script Generator Agent — converts plain text descriptions into
 * standard ScriptBundle format using DeepSeek.
 */

import { generateText } from 'ai';
import { getChatModel } from './deepseek';
import { extractJSON } from './utils';
import { ScriptBundleSchema, type ScriptBundle } from '../storage/storage-interface';

export interface GenerateScriptResult {
  script: ScriptBundle;
  rawResponse: string;
  durationMs: number;
}

const SYSTEM_PROMPT = `你是一个互动视觉小说剧本生成器。根据用户提供的描述，生成符合标准格式的完整剧本数据。

输出必须是严格的JSON格式，包含以下结构：
{
  "characters": [
    {
      "core": {
        "id": "角色英文ID（小写、连字符）",
        "name": "角色中文名",
        "background": "角色背景故事（100-200字）",
        "personality": [
          { "trait": "性格特征", "intensity": 0.0到1.0 }
        ],
        "values": ["核心价值观1", "核心价值观2"],
        "speechStyle": "说话风格描述",
        "appearance": "外貌描述"
      },
      "longTermGoals": [
        { "id": "目标英文ID", "description": "目标描述", "priority": 1到10 }
      ],
      "shortTermGoals": [],
      "personaShifts": []
    }
  ],
  "chapters": [
    {
      "chapter": "章节名",
      "events": [
        {
          "id": "事件英文ID",
          "time": 事件时间分钟数,
          "name": "事件名",
          "description": "事件详细描述",
          "location": "地点ID",
          "affectedCharacters": ["角色ID"],
          "severity": "minor或major或critical"
        }
      ],
      "locations": [
        { "id": "地点英文ID", "name": "地点中文名" }
      ]
    }
  ],
  "goapActions": [
    {
      "id": "动作英文ID",
      "name": "动作中文名",
      "preconditions": { "条件key": true },
      "effects": { "效果key": true },
      "cost": 数字,
      "timeCost": 耗时分钟数,
      "description": "动作描述"
    }
  ]
}

要求：
1. 至少生成1个主角 + 1个配角，每个角色至少3个性格特征
2. 至少生成5个世界事件，时间从480（08:00）递增到1200（20:00），severity合理分布
3. 至少生成5个地点
4. 至少生成6个GOAP动作，其中必须包含 id="go-to"（前往目的地，preconditions: {}, effects: {atDestination: true}, cost: 1, timeCost: 30）
5. 所有id必须是英文小写+连字符格式
6. 角色性格 intensity 在0到1之间，目标 priority 在1到10之间
7. GOAP动作的 preconditions 和 effects 使用布尔值
8. 叙事风格应与用户描述的世界观匹配
9. shortTermGoals 和 personaShifts 保持为空数组
10. 请以json格式输出，仅输出JSON，不要添加任何其他内容`;

/**
 * Generate a full ScriptBundle from a plain-text user description.
 */
export async function generateScript(
  userDescription: string,
): Promise<GenerateScriptResult> {
  const startTime = Date.now();

  const { text } = await generateText({
    model: getChatModel(),
    system: SYSTEM_PROMPT,
    prompt: `请根据以下描述生成完整的互动小说剧本数据：

${userDescription}

仅输出JSON。`,
  });

  const durationMs = Date.now() - startTime;
  const rawJson = extractJSON(text);
  const parsed = JSON.parse(rawJson);

  // Add metadata client-side
  const scriptBundle = ScriptBundleSchema.parse({
    metadata: {
      id: `gen-${Date.now()}`,
      name: parsed.chapters?.[0]?.chapter ?? '生成剧本',
      description: userDescription.slice(0, 100),
      author: 'AI生成',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
      source: 'generated',
    },
    ...parsed,
  });

  return { script: scriptBundle, rawResponse: text, durationMs };
}
