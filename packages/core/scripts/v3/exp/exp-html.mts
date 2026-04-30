// IVN v3 HTML 协议实验 entry。
//
// 验证：LLM 能否在不调任何 tool 情况下，用 HTML 协议（<p data-speaker|to|
// hear|eavesdroppers|bg|sprite|cg> / <div data-kind="scratch"> /
// <ul data-input="choices"> / <script application/x-state>）emit 完整一轮
// 叙事 + 互动选项 + 状态更新 + 视觉切换 + CG。
//
// 启动：
//   bun --env-file=apps/server/.env packages/core/scripts/v3/exp/exp-html.mts
//
// 期望：
//   - 5 turn 内 stderr 打 [turn N] frames=[...] scratch=N state=... ...
//   - LLM 输出含 <p>/<ul>/<script>，data-bg/sprite/cg 上挂在 p
//   - state 累积；choices 抽出
//   - /tmp/v3-exp-html.jsonl 落 KernelEvent 全流

import type { ModelMessage } from 'ai';

import { runEvalBatch, type Scenario } from '../eval.mts';
import type { AssembleInput } from '#internal/v3/assemble';
import { buildModelFromEnv } from '../_model.mts';
import { parseHtmlProtocol } from './protocol-html/parser.mts';
import { buildSystemPrompt } from './protocol-html/system-prompt.mts';
import type { Frame, SpriteSpec } from './protocol-html/types.mts';

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

const spriteToStr = (s: SpriteSpec): string =>
  `${s.char}${s.mood !== undefined ? '/' + s.mood : ''}${s.position !== undefined ? '/' + s.position : ''}`;

const frameSummary = (f: Frame): string => {
  const visuals: string[] = [];
  if (f.bg !== undefined) visuals.push(`bg=${f.bg}`);
  if (f.sprite !== undefined) visuals.push(`sprite=${spriteToStr(f.sprite)}`);
  if (f.cg !== undefined) visuals.push(`cg=${f.cg}`);
  const visualStr = visuals.length > 0 ? `[${visuals.join('|')}]` : '';

  if (f.kind === 'narration') {
    return `n${visualStr}:${f.text.slice(0, 16)}`;
  }
  const pf = f.pf;
  const audience = [
    pf.to !== undefined ? `→${pf.to}` : '',
    pf.hear !== undefined ? `+hear[${pf.hear.join(',')}]` : '',
    pf.eavesdroppers !== undefined ? `+eaves[${pf.eavesdroppers.join(',')}]` : '',
  ]
    .filter((s) => s.length > 0)
    .join('');
  return `d[${pf.speaker}${audience}]${visualStr}:${f.text.slice(0, 16)}`;
};

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

      const framesStr = parsed.frames.map(frameSummary).join(' | ');
      console.error(
        `[turn ${ctx.turn}] frames=[${framesStr}] scratch=${parsed.scratches.length} state=${JSON.stringify(state)} choices=[${lastChoices.join(', ')}] warnings=${parsed.warnings.length}`,
      );
      if (parsed.warnings.length > 0) {
        for (const w of parsed.warnings) console.error(`  ⚠ ${w}`);
      }
    }

    if (ctx.turn === 0) return '我循着鸟鸣进入森林深处';
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
