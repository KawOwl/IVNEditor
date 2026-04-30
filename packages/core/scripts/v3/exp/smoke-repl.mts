// Smoke：交互式 REPL。
//
// 前置：~/.config/ivn-editor/.env 含 LLM_PROVIDER / LLM_BASE_URL / LLM_API_KEY
// / LLM_MODEL（同 smoke-eval）。
//
// 启动：
//   bun --env-file=../../apps/server/.env packages/core/scripts/v3/exp/smoke-repl.mts
//
// 期望：`>` 提示符，输入文字 → 流式回复；Ctrl+C 退。

import type { ModelMessage } from 'ai';
import { startRepl } from '../repl.mts';
import type { AssembleInput } from '#internal/v3/assemble';
import { buildModelFromEnv } from '../_model.mts';

const buildSections = (_ctx: {
  messages: readonly ModelMessage[];
}): AssembleInput => ({
  systemSections: [
    {
      id: 'role',
      content: '你是友好简洁的助手。',
      priority: 1,
    },
  ],
  contextSections: [],
  budgetTokens: 4000,
});

await startRepl({
  model: buildModelFromEnv(),
  buildSections,
});
