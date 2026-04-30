// IVN v3 HTML 协议实验 entry。
//
// 验证：LLM 能否在不调任何 tool 情况下，用 HTML 协议（<p> / <p data-speaker> /
// <aside data-kind="scratch"> / <figure data-bg|data-sprite> / <menu> /
// <script application/x-state>）emit 完整一轮叙事 + 互动选项 + 状态更新。
//
// 启动：
//   bun --env-file=apps/server/.env packages/core/scripts/v3/exp/exp-html.mts
//
// 期望：
//   - 5 turn 内 stderr 打 [turn N] state=... choices=[...] warnings=...
//   - LLM 输出含 <p>/<menu>/<script>，不含 <narration>/<dialogue>/<sprite>
//   - state 累积（scene / explored_count / 等字段）
//   - /tmp/v3-exp-html.jsonl 落 KernelEvent 全流

import type { ModelMessage } from 'ai';

import { runEvalBatch, type Scenario } from '../eval.mts';
import type { AssembleInput } from '#internal/v3/assemble';
import { buildModelFromEnv } from '../_model.mts';
import { parseHtmlProtocol } from './protocol-html/parser.mts';
import { buildSystemPrompt } from './protocol-html/system-prompt.mts';

// scenario closure：state 同时给 buildSections 拼 prompt + 给 nextUserInput
// 决定下一句 + 给外部下游观察（console.error）
let state: Readonly<Record<string, unknown>> = {};
let lastChoices: readonly string[] = [];

const buildSections = (_ctx: {
  messages: readonly ModelMessage[];
}): AssembleInput => ({
  systemSections: [
    { id: 'protocol', content: buildSystemPrompt(state), priority: 1 },
  ],
  contextSections: [],
  budgetTokens: 8000,
});

const scenario: Scenario = {
  id: 'html-protocol-smoke',
  initialMessages: [],
  nextUserInput: async (ctx) => {
    if (ctx.lastAssistant !== undefined) {
      const parsed = parseHtmlProtocol(ctx.lastAssistant);
      if (parsed.stateUpdate !== null) {
        state = { ...state, ...parsed.stateUpdate };
      }
      lastChoices = parsed.choices?.options ?? [];

      const summary = parsed.units
        .map((u) =>
          u.kind === 'narration'
            ? `n:${u.text.slice(0, 20)}`
            : u.kind === 'dialogue'
              ? `d[${u.speaker}]:${u.text.slice(0, 20)}`
              : u.kind === 'scratch'
                ? `s:${u.text.slice(0, 20)}`
                : u.kind === 'background'
                  ? `bg:${u.bg}`
                  : `sprite:${u.char}`,
        )
        .join(' | ');
      console.error(
        `[turn ${ctx.turn}] units=[${summary}] state=${JSON.stringify(state)} choices=[${lastChoices.join(', ')}] warnings=${parsed.warnings.length}`,
      );
      if (parsed.warnings.length > 0) {
        for (const w of parsed.warnings) console.error(`  ⚠ ${w}`);
      }
    }

    if (ctx.turn === 0) return '我想探索四周';
    if (lastChoices.length > 0) return `选择：${lastChoices[0]}`;
    return null;
  },
  maxTurns: 5,
};

await runEvalBatch({
  model: buildModelFromEnv(),
  buildSections,
  scenarios: [scenario],
  reps: 1,
  outputJsonl: '/tmp/v3-exp-html.jsonl',
});
