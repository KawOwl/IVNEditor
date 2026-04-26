/**
 * Shared helpers for `scripts/evals/*.mts` entry files.
 *
 * Keep this thin —— scenario configs go to `scenarios/`，runner-glue 才进这里。
 */

import type { LLMConfig } from '#internal/llm-client';
import { createNoThinkingLLMConfig } from '#internal/evaluation/memory-harness';
import type { MemoryEvaluationReport } from '#internal/evaluation/memory-harness';

export function requireEnv(name: string): string {
  const value = Bun.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

/**
 * GM 侧 LLM 配置：从 LLM_* env 读。Thinking 默认关掉，要打开设
 * `LLM_THINKING=on`（可选 `LLM_REASONING_EFFORT=high|max`）。
 *
 * Player 侧（readPlayerLLMConfig）永远无脑关 thinking —— 玩家不需要思考。
 */
export function readGMLLMConfig(): LLMConfig {
  const thinking = parseThinkingEnv();
  return {
    provider: requireEnv('LLM_PROVIDER'),
    baseURL: requireEnv('LLM_BASE_URL'),
    apiKey: requireEnv('LLM_API_KEY'),
    model: requireEnv('LLM_MODEL'),
    name: Bun.env.LLM_NAME,
    maxOutputTokens: Number(Bun.env.LLM_MAX_OUTPUT_TOKENS ?? 1200),
    thinkingEnabled: thinking.enabled,
    reasoningEffort: thinking.reasoningEffort,
  };
}

/**
 * `LLM_THINKING` 解析：
 *   - `on` / `true` / `1` → 启用 thinking + 看 LLM_REASONING_EFFORT
 *   - `default` / `model-default` → 不传 thinking 字段，走模型默认
 *   - 其它（含缺省） → thinkingEnabled=false 强制关
 */
function parseThinkingEnv(): { enabled: boolean | null; reasoningEffort: 'high' | 'max' | null } {
  const raw = (Bun.env.LLM_THINKING ?? '').toLowerCase();
  if (raw === 'on' || raw === 'true' || raw === '1') {
    const effort = (Bun.env.LLM_REASONING_EFFORT ?? '').toLowerCase();
    return {
      enabled: true,
      reasoningEffort: effort === 'high' || effort === 'max' ? effort : null,
    };
  }
  if (raw === 'default' || raw === 'model-default') {
    return { enabled: null, reasoningEffort: null };
  }
  return { enabled: false, reasoningEffort: null };
}

/**
 * 玩家 simulator 用的 LLM。缺省复用 GM 的 provider/baseURL/apiKey/model，只把
 * maxOutputTokens 调小到 200（玩家输入短）。要分离的话设 PLAYER_LLM_* env。
 */
export function readPlayerLLMConfig(gm: LLMConfig): LLMConfig {
  return createNoThinkingLLMConfig({
    provider: Bun.env.PLAYER_LLM_PROVIDER ?? gm.provider,
    baseURL: Bun.env.PLAYER_LLM_BASE_URL ?? gm.baseURL,
    apiKey: Bun.env.PLAYER_LLM_API_KEY ?? gm.apiKey,
    model: Bun.env.PLAYER_LLM_MODEL ?? gm.model,
    name: 'player-simulator',
    maxOutputTokens: Number(Bun.env.PLAYER_LLM_MAX_OUTPUT_TOKENS ?? 200),
  });
}

export async function writeReport(
  outputPath: string,
  report: MemoryEvaluationReport,
): Promise<void> {
  await Bun.write(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

/**
 * 落 transcript markdown 到 outputPath 旁边（`<outputPath>.md`），给 LLM judge
 * 或人读用。原 .json raw report 不动。
 */
export async function writeTranscript(
  outputPath: string,
  report: MemoryEvaluationReport,
): Promise<string> {
  const { renderTranscript } = await import('#internal/evaluation/transcript-renderer');
  const transcriptPath = outputPath.endsWith('.json')
    ? outputPath.replace(/\.json$/, '.md')
    : `${outputPath}.md`;
  await Bun.write(transcriptPath, `${renderTranscript(report)}\n`);
  return transcriptPath;
}

/** 一行人类可读总结：`scenario=X variants=v1(turns,sentences,inputs),v2(...)` */
export function summarizeReport(report: MemoryEvaluationReport): string {
  const variants = report.runs
    .map((r) => `${r.variantId}(${r.turnsRun}t,${r.recording.sentences.length}s,${r.recording.inputRequests.length}i)`)
    .join(', ');
  return `scenario=${report.scenarioId} variants=${variants}`;
}

/** 跑完后做协议 + projection 校验，失败则 process.exit(1)。和 memory-live-eval.mts 同语义。 */
export function exitOnHarnessFailure(report: MemoryEvaluationReport): void {
  const protocolFailures = report.runs.filter((r) => !r.coreEventProtocol.ok);
  const projectionFailures = report.runs.filter((r) => !r.sessionEmitterProjection.ok);

  if (protocolFailures.length > 0) {
    console.error('CoreEvent protocol failures:');
    for (const run of protocolFailures) {
      console.error(`  ${run.variantId}: ${JSON.stringify(run.coreEventProtocol.violations)}`);
    }
    process.exit(1);
  }

  if (projectionFailures.length > 0) {
    console.error('SessionEmitter projection failures:');
    for (const run of projectionFailures) {
      console.error(`  ${run.variantId}: ${run.sessionEmitterProjection.mismatches.join(', ')}`);
    }
    process.exit(1);
  }
}
