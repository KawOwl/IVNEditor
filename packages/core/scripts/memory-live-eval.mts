import {
  createNoThinkingLLMConfig,
  runLiveMemoryEvaluationSuite,
  type LiveMemoryEvaluationOptions,
  type PlayerSource,
} from '#internal/evaluation/memory-harness';
import { createLLMPlayerSimulator } from '#internal/evaluation/player-simulator';
import { buildParserManifest } from '#internal/narrative-parser-v2';
import type { LLMConfig } from '#internal/llm-client';
import type {
  BackgroundAsset,
  CharacterAsset,
  MemoryConfig,
  PromptSegment,
  ScriptManifest,
  StateSchema,
} from '#internal/types';

async function main(): Promise<void> {
  const outputPath = Bun.env.MEMORY_EVAL_OUTPUT ?? '/tmp/ivn-memory-live-eval.json';
  const variants = readVariants();
  const llmConfig = createNoThinkingLLMConfig(readLLMConfig());
  const scenario = createLiveScenario();
  const player = readPlayerSource();
  const maxTurns = Number(
    Bun.env.MEMORY_EVAL_MAX_TURNS
      ?? (player.kind === 'scripted' ? player.inputs.length + 1 : '15'),
  );

  const report = await runLiveMemoryEvaluationSuite({
    scenario,
    variants,
    llmConfig,
    player,
    maxTurns,
  } satisfies LiveMemoryEvaluationOptions);

  await Bun.write(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  const protocolFailures = report.runs.filter((run) => !run.coreEventProtocol.ok);
  const projectionFailures = report.runs.filter((run) => !run.sessionEmitterProjection.ok);
  const inputRequestCounts = report.runs.map((run) => run.recording.inputRequests.length);

  console.log(`live memory eval wrote ${outputPath}`);
  console.log(`scenario=${report.scenarioId}`);
  console.log(`variants=${report.runs.map((run) => run.variantId).join(', ')}`);
  console.log(`turns=${report.runs.map((run) => `${run.variantId}:${run.turnsRun}`).join(', ')}`);
  console.log(`inputRequests=${inputRequestCounts.join(', ')}`);
  console.log(`sessionEmitterProjection=${projectionFailures.length === 0 ? 'ok' : 'failed'}`);
  console.log(`llm thinkingEnabled=${String(llmConfig.thinkingEnabled)}`);
  console.log(`llm reasoningEffort=${String(llmConfig.reasoningEffort)}`);

  if (protocolFailures.length > 0) {
    console.error('CoreEvent protocol failures:');
    for (const run of protocolFailures) {
      console.error(`${run.variantId}: ${JSON.stringify(run.coreEventProtocol.violations)}`);
    }
    process.exit(1);
  }

  if (projectionFailures.length > 0) {
    console.error('SessionEmitter projection failures:');
    for (const run of projectionFailures) {
      console.error(`${run.variantId}: ${run.sessionEmitterProjection.mismatches.join(', ')}`);
    }
    process.exit(1);
  }

  if (inputRequestCounts.some((count) => count < 1)) {
    console.error('Expected every live run to reach at least one input request.');
    process.exit(1);
  }
}

function readLLMConfig(): LLMConfig {
  return {
    provider: requiredEnv('LLM_PROVIDER'),
    baseURL: requiredEnv('LLM_BASE_URL'),
    apiKey: requiredEnv('LLM_API_KEY'),
    model: requiredEnv('LLM_MODEL'),
    name: Bun.env.LLM_NAME,
    maxOutputTokens: Number(Bun.env.LLM_MAX_OUTPUT_TOKENS ?? 1200),
    thinkingEnabled: false,
    reasoningEffort: null,
  };
}

function readInputs(): readonly string[] {
  if (!Bun.env.MEMORY_EVAL_INPUTS) {
    return ['收下银钥匙，并询问 Luna 禁门的位置。'];
  }
  const parsed = JSON.parse(Bun.env.MEMORY_EVAL_INPUTS) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    throw new Error('MEMORY_EVAL_INPUTS must be a JSON array of strings');
  }
  return parsed;
}

/**
 * MEMORY_EVAL_PLAYER_GOAL 设了 → 走 LLM-driven simulator；否则用 scripted inputs。
 * Simulator 路径需要单独的 LLM 配置（MEMORY_EVAL_PLAYER_LLM_*），不复用 GM 的，
 * 让两侧可以拆开模型 / API key（同模型也行，重复声明而已）。
 *
 * 返回的是 factory，每个 variant 进入时调一次新建一个 simulator —— 否则跨 variant
 * 共享 instance，chat history 累积，A/B 对比不公平。
 */
function readPlayerSource(): PlayerSource {
  const goal = Bun.env.MEMORY_EVAL_PLAYER_GOAL;
  if (!goal) {
    return { kind: 'scripted', inputs: readInputs() };
  }
  const llmConfig = createNoThinkingLLMConfig({
    provider: requiredEnv('MEMORY_EVAL_PLAYER_LLM_PROVIDER'),
    baseURL: requiredEnv('MEMORY_EVAL_PLAYER_LLM_BASE_URL'),
    apiKey: requiredEnv('MEMORY_EVAL_PLAYER_LLM_API_KEY'),
    model: requiredEnv('MEMORY_EVAL_PLAYER_LLM_MODEL'),
    name: 'player-simulator',
    maxOutputTokens: Number(Bun.env.MEMORY_EVAL_PLAYER_LLM_MAX_OUTPUT_TOKENS ?? 200),
  });
  const style = Bun.env.MEMORY_EVAL_PLAYER_STYLE;
  return {
    kind: 'simulated',
    createSimulator: () => createLLMPlayerSimulator({ goal, style, llmConfig }),
  };
}

function readVariants(): LiveMemoryEvaluationOptions['variants'] {
  const rawVariants: string = Bun.env.MEMORY_EVAL_VARIANTS ?? 'legacy,llm-summarizer';
  const ids = rawVariants
    .split(',')
    .map((id: string) => id.trim())
    .filter(Boolean);

  return ids.map((id: string) => {
    if (id === 'noop') {
      return { id, memoryConfig: { ...baseMemoryConfig, provider: 'noop' } };
    }
    if (id === 'legacy') {
      return { id, memoryConfig: { ...baseMemoryConfig, provider: 'legacy' } };
    }
    if (id === 'llm-summarizer') {
      return { id, memoryConfig: { ...baseMemoryConfig, provider: 'llm-summarizer' } };
    }
    if (id === 'mem0') {
      const mem0ApiKey = Bun.env.MEM0_API_KEY;
      if (!mem0ApiKey) {
        throw new Error('Variant "mem0" requires MEM0_API_KEY env var');
      }
      return { id, memoryConfig: { ...baseMemoryConfig, provider: 'mem0' }, mem0ApiKey };
    }
    throw new Error(`Unknown memory eval variant "${id}" (expected noop / legacy / llm-summarizer / mem0)`);
  });
}

function createLiveScenario(): LiveMemoryEvaluationOptions['scenario'] {
  const characters: CharacterAsset[] = [
    {
      id: 'luna',
      displayName: 'Luna',
      sprites: [
        { id: 'neutral', label: 'neutral' },
        { id: 'smile', label: 'smile' },
      ],
    },
  ];
  const backgrounds: BackgroundAsset[] = [
    { id: 'library_hall', label: 'library hall' },
    { id: 'deep_stacks', label: 'deep stacks' },
  ];
  const manifest = {
    characters,
    backgrounds,
  } satisfies Pick<ScriptManifest, 'characters' | 'backgrounds'>;

  return {
    id: 'live-memory-silver-key',
    segments: [systemSegment],
    stateSchema,
    initialPrompt: '开场：玩家在图书馆大厅遇见 Luna，她正把一枚银钥匙递给玩家。',
    enabledTools: ['signal_input_needed', 'update_state'],
    tokenBudget: 24000,
    defaultScene: {
      background: 'library_hall',
      sprites: [{ id: 'luna', emotion: 'neutral', position: 'center' }],
    },
    protocolVersion: 'v2-declarative-visual',
    parserManifest: buildParserManifest(manifest),
    characters,
    backgrounds,
  };
}

function requiredEnv(name: string): string {
  const value = Bun.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}`);
  }
  return value;
}

const stateSchema: StateSchema = {
  variables: [
    {
      name: 'current_scene',
      type: 'string',
      initial: 'library_hall',
      description: '当前场景。',
    },
    {
      name: 'has_silver_key',
      type: 'boolean',
      initial: false,
      description: '玩家是否已经拿到银钥匙。',
    },
    {
      name: 'knows_locked_door',
      type: 'boolean',
      initial: false,
      description: '玩家是否知道禁门位置。',
    },
  ],
};

const baseMemoryConfig: MemoryConfig = {
  contextBudget: 4000,
  compressionThreshold: 1,
  recencyWindow: 2,
  compressionHints: '保留 Luna、银钥匙、禁门位置、玩家选择和状态变化。',
};

const systemSegment: PromptSegment = {
  id: 'live-rules',
  label: 'Live Eval Rules',
  content: [
    '你是互动小说 GM。',
    '每轮输出一小段当前格式的叙事 XML，并用 signal_input_needed 给玩家 2-3 个选择。',
    '当玩家收下银钥匙时，调用 update_state 设置 {"has_silver_key":true}。',
    '当 Luna 告诉玩家禁门在书架深处时，调用 update_state 设置 {"knows_locked_door":true,"current_scene":"deep_stacks"}。',
    '不要输出解释性元话语。',
  ].join('\n'),
  contentHash: 'live-rules-hash',
  type: 'content',
  sourceDoc: 'live-memory-eval',
  role: 'system',
  priority: 0,
  tokenCount: 120,
};

await main();
