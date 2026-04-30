// Smoke test：用真实 LLM 跑 v3 eval batch，验证 kernel + driver + assemble +
// runEvalBatch 全链路。
//
// 前置：~/.config/ivn-editor/.env 含 LLM_PROVIDER / LLM_BASE_URL / LLM_API_KEY
// / LLM_MODEL（pnpm setup:env 已链到 apps/server/.env）。
//
// 启动：
//   bun --env-file=../../apps/server/.env packages/core/scripts/v3/exp/smoke-eval.mts
//
// 期望输出：
//   - stderr 打 ✓ smoke-2-turn rep 1 → 2 turns, last=stop
//   - /tmp/v3-smoke.jsonl 写入一行 JSON（含 2 turn × 全部 KernelEvent）

import type { ModelMessage } from 'ai';
import { runEvalBatch, type Scenario } from '../eval.mts';
import type { AssembleInput } from '#internal/v3/assemble';
import { buildModelFromEnv } from '../_model.mts';

const buildSections = (_ctx: {
  messages: readonly ModelMessage[];
}): AssembleInput => ({
  systemSections: [
    {
      id: 'role',
      content: '你是友好简洁的助手。回答尽量短（1-2 句）。',
      priority: 1,
    },
  ],
  contextSections: [],
  budgetTokens: 4000,
});

const scenario: Scenario = {
  id: 'smoke-2-turn',
  nextUserInput: async (ctx) => {
    const inputs = [
      '你好，请用一句话介绍自己',
      '简单说说今天天气',
    ];
    return inputs[ctx.turn] ?? null;
  },
  maxTurns: 3,
};

await runEvalBatch({
  model: buildModelFromEnv(),
  buildSections,
  scenarios: [scenario],
  reps: 1,
  outputJsonl: '/tmp/v3-smoke.jsonl',
});
