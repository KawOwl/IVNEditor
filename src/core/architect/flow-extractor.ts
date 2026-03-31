/**
 * Flow Extractor Agent — Step 2.3
 *
 * Analyzes GM prompt documents to extract FlowGraph:
 * nodes (visual reference) and edges (connections between scenes).
 *
 * FlowGraph is a visualization aid, NOT runtime control flow.
 * The LLM drives all transitions via tool calls at runtime.
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

FlowGraph 是可视化参考图，帮助编剧理解叙事结构。
它不做运行时路由——LLM 在运行时通过工具调用自主控制流程。

提取规则：
1. 每个阶段/章节/场景 → 一个节点
2. 节点包含：id、label（显示名称）、description（简短描述）
3. 节点之间的逻辑关系 → 边（仅 label，无条件表达式）
4. 循环/分支结构用边表示，label 描述关系
5. promptSegments 暂时留空（后续由 Prompt 拆分 Agent 填充）`;

const flowSchema = z.object({
  nodes: z.array(z.object({
    id: z.string(),
    label: z.string(),
    description: z.string().optional(),
  })),
  edges: z.array(z.object({
    from: z.string(),
    to: z.string(),
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
      label: n.label,
      description: n.description,
      promptSegments: [],
    })),
    edges: result.object.edges.map((e) => ({
      from: e.from,
      to: e.to,
      label: e.label,
    })),
  };

  return {
    graph,
    reasoning: result.object.reasoning,
  };
}
