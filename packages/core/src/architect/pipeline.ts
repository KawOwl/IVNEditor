/**
 * Architect Pipeline — Orchestrates all extraction agents
 *
 * Runs the full pipeline: classify → extract state → extract flow →
 * split prompts → generate rules → enable tools → memory strategy.
 */

import type { LanguageModel } from 'ai';
import type {
  ArchitectResult,
  AgentProgressCallback,
} from './types';
import { classifyDocuments } from './document-classifier';
import { extractStateVariables } from './state-extractor';
import { extractFlowGraph } from './flow-extractor';
import { splitPrompts } from './prompt-splitter';
import { generateInjectionRules } from './injection-rule-generator';
import { determineToolEnablement } from './tool-enabler';
import { generateMemoryStrategy } from './memory-strategy-generator';

export async function runArchitectPipeline(
  rawDocuments: Array<{ filename: string; content: string }>,
  model: LanguageModel,
  onProgress?: AgentProgressCallback,
): Promise<ArchitectResult> {
  // Step 1: Classify documents
  onProgress?.('classify', '正在分类文档...');
  const { documents, classifications } = await classifyDocuments(rawDocuments, model);

  // Step 2: Extract state variables
  onProgress?.('state', '正在提取状态变量...');
  const stateExtraction = await extractStateVariables(documents, model);

  // Step 3: Extract flow graph
  onProgress?.('flow', '正在提取流程结构...');
  const flowExtraction = await extractFlowGraph(documents, model);

  // Step 4: Split prompts
  onProgress?.('split', '正在拆分 Prompt...');
  const promptSplit = await splitPrompts(documents, model);

  // Step 5: Generate injection rules
  onProgress?.('rules', '正在生成注入规则...');
  const injectionRules = await generateInjectionRules(documents, promptSplit.segments, model);

  // Step 6: Determine tool enablement
  onProgress?.('tools', '正在配置工具...');
  const toolEnablement = await determineToolEnablement(documents, stateExtraction.schema, model);

  // Step 7: Generate memory strategy
  onProgress?.('memory', '正在生成记忆策略...');
  const memoryStrategy = await generateMemoryStrategy(documents, model);

  onProgress?.('done', '提取完成');

  return {
    documents,
    classification: classifications,
    stateExtraction,
    flowExtraction,
    promptSplit,
    injectionRules,
    toolEnablement,
    memoryStrategy,
  };
}
