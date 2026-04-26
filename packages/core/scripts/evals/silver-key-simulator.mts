/**
 * Silver-key · simulator 玩家 · noop vs mem0 对比
 *
 * 用法：
 *   LLM_PROVIDER=openai-compatible \
 *   LLM_BASE_URL=https://api.deepseek.com/v1 \
 *   LLM_API_KEY=sk-... \
 *   LLM_MODEL=deepseek-chat \
 *   MEM0_API_KEY=mem-... \
 *   bun packages/core/scripts/evals/silver-key-simulator.mts
 *
 * 输出：/tmp/silver-key-simulator.json
 *
 * 可选 env：
 *   VARIANTS=noop,mem0   要跑的 provider 列表（逗号分隔），缺省 'noop,mem0'。
 *                        例如只跑 noop 调试 GM：VARIANTS=noop
 *   REPS=2               每个 provider 各跑 N 次（id 加 -rep1 / -rep2 后缀确保
 *                        mem0 user_id 隔离 → 跨 rep 互不污染）。默认 1。
 *   MAX_TURNS=15         每次 run 的最大 turn 数。默认 12。
 *   OUTPUT=path          输出 JSON 路径，默认 /tmp/silver-key-simulator.json
 *   LLM_THINKING=on      开 GM 的 thinking 模式（DeepSeek V4 等）。默认关。
 *   LLM_REASONING_EFFORT=high  thinking 强度（仅 thinking=on 时有效）
 *
 * 玩家 LLM 默认复用 GM 的 LLM_* 配置；要分离的话设 PLAYER_LLM_*。玩家侧 thinking
 * 永远关。
 */

import type { MemoryEvaluationVariant } from '#internal/evaluation/memory-harness';
import { runLiveMemoryEvaluationSuite } from '#internal/evaluation/memory-harness';
import { createLLMPlayerSimulator } from '#internal/evaluation/player-simulator';
import {
  silverKeyScenario,
  silverKeyMemoryConfig,
  silverKeyPersona,
} from './scenarios/silver-key.mts';
import {
  readGMLLMConfig,
  readPlayerLLMConfig,
  requireEnv,
  writeReport,
  writeTranscript,
  summarizeReport,
  exitOnHarnessFailure,
} from './_helpers.mts';

const llm = readGMLLMConfig();
const playerLLMConfig = readPlayerLLMConfig(llm);
const outputPath = Bun.env.OUTPUT ?? '/tmp/silver-key-simulator.json';
const reps = Math.max(1, Number(Bun.env.REPS ?? 1));

const enabledProviders = (Bun.env.VARIANTS ?? 'noop,mem0')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const wantsNoop = enabledProviders.includes('noop');
const wantsMem0 = enabledProviders.includes('mem0');
const mem0ApiKey = wantsMem0 ? requireEnv('MEM0_API_KEY') : '';

const variants: MemoryEvaluationVariant[] = [
  ...(wantsNoop ? Array.from({ length: reps }, (_, i) => ({
    id: reps > 1 ? `noop-rep${i + 1}` : 'noop',
    memoryConfig: { ...silverKeyMemoryConfig, provider: 'noop' as const },
  })) : []),
  ...(wantsMem0 ? Array.from({ length: reps }, (_, i) => ({
    id: reps > 1 ? `mem0-rep${i + 1}` : 'mem0',
    memoryConfig: { ...silverKeyMemoryConfig, provider: 'mem0' as const },
    mem0ApiKey,
  })) : []),
];

if (variants.length === 0) {
  throw new Error(`VARIANTS="${Bun.env.VARIANTS ?? ''}" 没匹配任何 provider；用 noop / mem0 / noop,mem0`);
}

const maxTurns = Number(Bun.env.MAX_TURNS ?? 12);
console.log(`▶ ${variants.length} variants × ${maxTurns} max turns = up to ${variants.length * maxTurns * 2} LLM calls`);
console.log(`  variants: ${variants.map((v) => v.id).join(', ')}`);

const report = await runLiveMemoryEvaluationSuite({
  scenario: silverKeyScenario,
  variants,
  llmConfig: llm,
  player: {
    kind: 'simulated',
    createSimulator: () => createLLMPlayerSimulator({
      ...silverKeyPersona,
      llmConfig: playerLLMConfig,
    }),
  },
  maxTurns,
});

await writeReport(outputPath, report);
const transcriptPath = await writeTranscript(outputPath, report);
console.log(`✓ wrote ${outputPath}`);
console.log(`✓ wrote ${transcriptPath} (LLM judge / human readable)`);
console.log(summarizeReport(report));
exitOnHarnessFailure(report);
