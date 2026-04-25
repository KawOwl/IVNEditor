/**
 * Tool Enabler Agent — Step 2.6
 *
 * Determines which optional tools the GM should have access to,
 * and generates a JSON Schema for update_state based on StateSchema.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import type { UploadedDocument, ToolEnablementResult } from '#internal/architect/types';
import type { StateSchema } from '#internal/types';

// ============================================================================
// Constants
// ============================================================================

const OPTIONAL_TOOLS = [
  'read_state',
  'query_changelog',
  'pin_memory',
  'query_memory',
  'inject_context',
  'list_context',
  'set_mood',
  'change_scene',
  'change_sprite',
  'clear_stage',
] as const;

// ============================================================================
// Extraction Prompt
// ============================================================================

const TOOL_ENABLEMENT_SYSTEM = `你是一个互动小说引擎的工具配置助手。
GM（游戏主持人）有两个必选工具（update_state、signal_input_needed）和 8 个可选工具。

可选工具及用途：
- read_state: 读取当前状态变量（GM 需要查看非 prompt 内的状态时）
- query_changelog: 查询状态变更历史（GM 需要回顾变量变化过程时）
- pin_memory: 标记重要记忆，压缩时保留（有需要长期记住的信息时）
- query_memory: 搜索历史记忆（GM 需要回忆过去事件时）
- inject_context: 临时注入世界观文档（GM 需要参考额外资料时）
- list_context: 列出可注入的文档（配合 inject_context 使用）
- set_mood: 设置场景氛围标签（影响 UI 视觉风格时）
- change_scene: 切换背景 / 替换所有立绘 / 应用过渡（VN 场景变化）
- change_sprite: 切换单个角色的表情或位置（不影响背景或其他立绘）
- clear_stage: 清除所有立绘（场景淡出或戏剧性停顿）

请根据 GM 提示词的内容，判断哪些可选工具应该启用。
如果文档中没有明确提及某工具的使用场景，默认不启用。
有视觉资产（立绘/背景）的剧本推荐启用 change_scene + change_sprite。`;

const enablementSchema = z.object({
  enabledTools: z.array(z.enum([
    'read_state', 'query_changelog', 'pin_memory', 'query_memory',
    'inject_context', 'list_context', 'set_mood',
    'change_scene', 'change_sprite', 'clear_stage',
  ])),
  reasoning: z.string(),
});

// ============================================================================
// Generate update_state Schema from StateSchema
// ============================================================================

function generateUpdateStateSchema(stateSchema: StateSchema): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  for (const variable of stateSchema.variables) {
    const prop: Record<string, unknown> = {
      description: variable.description,
    };

    switch (variable.type) {
      case 'number':
        prop.type = 'number';
        if (variable.range) {
          if (variable.range.min !== undefined) prop.minimum = variable.range.min;
          if (variable.range.max !== undefined) prop.maximum = variable.range.max;
        }
        break;
      case 'string':
        prop.type = 'string';
        break;
      case 'boolean':
        prop.type = 'boolean';
        break;
      case 'array':
        prop.type = 'array';
        break;
      case 'object':
        prop.type = 'object';
        break;
    }

    properties[variable.name] = prop;
  }

  return {
    type: 'object',
    properties: {
      patch: {
        type: 'object',
        description: '要更新的状态变量键值对',
        properties,
      },
    },
    required: ['patch'],
  };
}

// ============================================================================
// Determine Tool Enablement
// ============================================================================

export async function determineToolEnablement(
  documents: UploadedDocument[],
  stateSchema: StateSchema,
  model: LanguageModel,
): Promise<ToolEnablementResult> {
  const gmDocs = documents.filter((d) => d.role === 'gm_prompt');
  const allDocs = gmDocs.length > 0 ? gmDocs : documents;

  const docContent = allDocs
    .map((d) => `--- ${d.filename} ---\n${d.content}`)
    .join('\n\n');

  const result = await generateObject({
    model,
    system: TOOL_ENABLEMENT_SYSTEM,
    prompt: `请根据以下 GM 提示词判断需要启用哪些可选工具：\n\n${docContent}`,
    schema: enablementSchema,
  });

  return {
    enabledOptionalTools: result.object.enabledTools,
    updateStateSchema: generateUpdateStateSchema(stateSchema),
    reasoning: result.object.reasoning,
  };
}

export { OPTIONAL_TOOLS };
