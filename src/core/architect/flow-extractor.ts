/**
 * Flow Extractor Agent — Step 2.3
 *
 * Analyzes GM prompt documents to extract FlowGraph:
 * nodes (scene/input/compress/state-update/checkpoint) and edges with conditions.
 *
 * Looks for stage maps, convergence protocols, and phase transitions.
 */

import { generateObject } from 'ai';
import { z } from 'zod';
import type { LanguageModel } from 'ai';
import type { UploadedDocument, FlowExtractionResult } from './types';
import type { FlowGraph } from '../types';

// ============================================================================
// Extraction Prompt
// ============================================================================

const FLOW_EXTRACTION_SYSTEM = `你是一个互动小说引擎的流程分析助手。
你的任务是从 GM 提示词文档中提取游戏的流程结构（FlowGraph）。

提取规则：
1. 阶段/章节/场景 → scene 节点
2. "等待玩家输入/回应/选择" → input 节点
3. "压缩记忆/总结前文" → compress 节点
4. "更新状态/设置变量" → state-update 节点（仅当流程中有明确的批量状态更新点）
5. "存档点/检查点" → checkpoint 节点
6. 阶段之间的转换条件 → edge 的 condition（JavaScript 表达式）
7. 循环结构（如"重复直到..."）→ 回边
8. 无条件的默认转换 → edge 不设 condition

节点 config 说明：
- scene: { type: "scene", promptSegments: [], auto: false }
  - auto=true 表示 GM 自动生成，不等玩家输入
  - promptSegments 暂时留空（后续由 Prompt 拆分 Agent 填充）
- input: { type: "input", inputType: "freetext" 或 "choice", promptHint: "提示文字" }
- compress: { type: "compress" }
- state-update: { type: "state-update", updates: {} }
- checkpoint: { type: "checkpoint" }`;

const flowSchema = z.object({
  nodes: z.array(z.object({
    id: z.string(),
    type: z.enum(['scene', 'input', 'compress', 'state-update', 'checkpoint']),
    label: z.string(),
    config: z.record(z.string(), z.unknown()),
  })),
  edges: z.array(z.object({
    from: z.string(),
    to: z.string(),
    condition: z.string().optional(),
    label: z.string().optional(),
  })),
  reasoning: z.string(),
});

// ============================================================================
// Extract Flow Graph
// ============================================================================

export async function extractFlowGraph(
  documents: UploadedDocument[],
  model: LanguageModel,
): Promise<FlowExtractionResult> {
  const gmDocs = documents.filter((d) => d.role === 'gm_prompt');
  const allDocs = gmDocs.length > 0 ? gmDocs : documents;

  const docContent = allDocs
    .map((d) => `--- ${d.filename} ---\n${d.content}`)
    .join('\n\n');

  const result = await generateObject({
    model,
    system: FLOW_EXTRACTION_SYSTEM,
    prompt: `请从以下文档中提取游戏流程结构：\n\n${docContent}`,
    schema: flowSchema,
  });

  const graph: FlowGraph = {
    id: 'main',
    label: '主流程',
    nodes: result.object.nodes.map((n) => ({
      id: n.id,
      type: n.type,
      label: n.label,
      config: { type: n.type, ...n.config } as FlowGraph['nodes'][number]['config'],
    })),
    edges: result.object.edges.map((e) => ({
      from: e.from,
      to: e.to,
      condition: e.condition,
      label: e.label,
    })),
  };

  return {
    graph,
    reasoning: result.object.reasoning,
  };
}
