/**
 * Silver-key · scripted inputs · 3 个 memory variant 对比
 *
 * 用法：
 *   LLM_PROVIDER=openai-compatible \
 *   LLM_BASE_URL=https://api.deepseek.com/v1 \
 *   LLM_API_KEY=sk-... \
 *   LLM_MODEL=deepseek-chat \
 *   bun packages/core/scripts/evals/silver-key-scripted.mts
 *
 * 输出：/tmp/silver-key-scripted.json
 */

import { runLiveMemoryEvaluationSuite } from '#internal/evaluation/memory-harness';
import {
  silverKeyScenario,
  silverKeyMemoryConfig,
} from './scenarios/silver-key.mts';
import {
  readGMLLMConfig,
  writeReport,
  writeTranscript,
  summarizeReport,
  exitOnHarnessFailure,
} from './_helpers.mts';

const llm = readGMLLMConfig();
const outputPath = Bun.env.OUTPUT ?? '/tmp/silver-key-scripted.json';

const report = await runLiveMemoryEvaluationSuite({
  scenario: silverKeyScenario,
  variants: [
    { id: 'noop', memoryConfig: { ...silverKeyMemoryConfig, provider: 'noop' } },
    { id: 'legacy', memoryConfig: { ...silverKeyMemoryConfig, provider: 'legacy' } },
    { id: 'llm-summarizer', memoryConfig: { ...silverKeyMemoryConfig, provider: 'llm-summarizer' } },
  ],
  llmConfig: llm,
  player: {
    kind: 'scripted',
    inputs: [
      '收下银钥匙',
      '询问禁门的位置',
      '前往禁门',
    ],
  },
  maxTurns: 5,
});

await writeReport(outputPath, report);
const transcriptPath = await writeTranscript(outputPath, report);
console.log(`✓ wrote ${outputPath}`);
console.log(`✓ wrote ${transcriptPath} (LLM judge / human readable)`);
console.log(summarizeReport(report));
exitOnHarnessFailure(report);
