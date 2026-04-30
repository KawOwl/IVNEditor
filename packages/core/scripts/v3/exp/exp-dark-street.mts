// 暗街 × v3 HTML 协议实验 entry
//
// 流程：
//   v3 HTML 协议头（含当前 state JSON snapshot）+ 暗街 manifest+loader 按
//   state 路由拼好的内容 → 一段 system prompt → 喂 kernel
//   LLM emit HTML → parser 抽 state update → merge 到 closure state →
//   下轮 buildSections 用新 state 重新拼 system → 闭环
//
// 启动：
//   MAX_TURNS=20 bun --env-file=apps/server/.env packages/core/scripts/v3/exp/exp-dark-street.mts

import * as path from 'node:path';

import type { ModelMessage } from 'ai';

import { runEvalBatch, type Scenario } from '../eval.mts';
import type { AssembleInput } from '#internal/v3/assemble';
import { buildModelFromEnv } from '../_model.mts';
import { parseHtmlProtocol } from './protocol-html/parser.mts';
import { buildSystemPrompt as buildV3HtmlHeader } from './protocol-html/system-prompt.mts';
import {
  assembleContext,
  loadManifest,
  type Manifest,
  type State as LoaderState,
} from './dark-street/loader.mts';

const ROOT = path.join(import.meta.dir, 'dark-street');
const MANIFEST: Manifest = loadManifest(path.join(ROOT, 'manifest.json'));

// 宽松 state：必备字段（loader 路由用）+ 业务字段（LLM 自主维护）
// state 整体 JSON inject 到 v3 协议头的"当前 state"段，LLM 看到全字段并自主更新
let state: Record<string, unknown> = {
  // loader 路由：必备
  chapter: 1,
  phase: 1,
  loadAdjacentPhases: 1,

  // 业务 state（00_引擎 规则要求 LLM 维护）
  status: 'INIT',
  karina_attitude: 0,
  game_time: '06:00',
  pursueIndex: 0,
  traceValue: 0,
  charactersOnStage: [],
  factionsRelevant: [],
};

let lastChoices: readonly string[] = [];

const buildSections = (_ctx: {
  messages: readonly ModelMessage[];
}): AssembleInput => {
  const v3Header = buildV3HtmlHeader(state);
  // loader 类型严格，state 走宽松 Record 来；运行时投影必备字段（chapter/phase）
  const darkStreetCtx = assembleContext(
    ROOT,
    MANIFEST,
    state as unknown as LoaderState,
  );
  return {
    systemSections: [
      { id: 'v3-protocol', content: v3Header, priority: 1, tag: 'protocol' },
      {
        id: 'dark-street-context',
        content: darkStreetCtx,
        priority: 2,
        tag: 'scenario',
      },
    ],
    contextSections: [],
    budgetTokens: 100_000,
  };
};

const scenario: Scenario = {
  id: 'dark-street-smoke',
  initialMessages: [],
  nextUserInput: async (ctx) => {
    if (ctx.lastAssistant !== undefined) {
      const parsed = parseHtmlProtocol(ctx.lastAssistant);
      if (parsed.stateUpdate !== null) {
        state = { ...state, ...parsed.stateUpdate };
      }
      lastChoices = parsed.choices?.options ?? [];

      console.error(
        `[turn ${ctx.turn}] frames=${parsed.frames.length} ` +
          `scratch=${parsed.scratches.length} ` +
          `state=${JSON.stringify(state).slice(0, 220)}... ` +
          `choices=${lastChoices.length} warnings=${parsed.warnings.length}`,
      );
      if (parsed.warnings.length > 0) {
        for (const w of parsed.warnings) console.error(`  ⚠ ${w}`);
      }
    }

    if (ctx.turn === 0) return '开始';
    if (lastChoices.length > 0) return `选择：${lastChoices[0]}`;
    return null;
  },
};

await runEvalBatch({
  model: buildModelFromEnv(),
  buildSections,
  scenarios: [scenario],
  reps: 1,
  outputJsonl: '/tmp/v3-exp-dark-street.jsonl',
});
