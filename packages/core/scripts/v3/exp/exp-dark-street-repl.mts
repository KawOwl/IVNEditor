// 暗街 × v3 HTML 协议交互 REPL
//
// 启动：
//   bun --env-file=apps/server/.env packages/core/scripts/v3/exp/exp-dark-street-repl.mts
//
// 行为：
//   - 单行 readline 提示符 "> "
//   - 每轮 LLM 输出流式打印；reasoning 走 stderr (dim)
//   - turn 末展示 frames / state / choices 摘要 + warnings
//   - 玩家可输入选项数字 / 选项文字 / 任意自然语言
//   - Ctrl+C 退
//
// 与 exp-dark-street.mts (eval 版) 共享：
//   - state 闭包形态 + 字段
//   - buildSections（v3 header + 暗街 loader 拼装）
//   - parseHtmlProtocol post-turn 抽 state update / choices

import * as readline from 'node:readline/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin, stdout, stderr } from 'process';

import type { ModelMessage } from 'ai';

import { run } from '#internal/v3/kernel/driver';
import type { TokenUsage } from '#internal/v3/kernel/types';
import { packSections, type AssembleInput } from '#internal/v3/assemble';
import { consumeKernel } from '#internal/v3/consume';
import { buildModelFromEnv } from '../_model.mts';
import { parseHtmlProtocol } from './protocol-html/parser.mts';
import { buildSystemPrompt as buildV3HtmlHeader } from './protocol-html/system-prompt.mts';
import {
  loadManifest,
  type Manifest,
  type State as LoaderState,
} from './dark-street/loader.mts';
import {
  buildSnapshot,
  formatTurnLog,
  type ContextSnapshot,
} from './dark-street/log-context.mts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dark-street');
const MANIFEST: Manifest = loadManifest(path.join(ROOT, 'manifest.json'));

let prevSnapshot: ContextSnapshot | null = null;
let buildTurn = 0;

let state: Record<string, unknown> = {
  chapter: 1,
  phase: 1,
  loadAdjacentPhases: 1,
  status: 'INIT',
  karina_attitude: 0,
  game_time: '06:00',
  pursueIndex: 0,
  traceValue: 0,
  charactersOnStage: [],
  factionsRelevant: [],
};

const buildSections = (
  _messages: readonly ModelMessage[],
): AssembleInput => {
  buildTurn += 1;
  const v3Header = buildV3HtmlHeader(state);
  const snap = buildSnapshot(
    ROOT,
    MANIFEST,
    state as unknown as LoaderState,
  );
  stderr.write(`\x1b[2m${formatTurnLog(buildTurn, snap, prevSnapshot)}\x1b[0m\n`);
  prevSnapshot = snap;
  return {
    systemSections: [
      { id: 'v3-protocol', content: v3Header, priority: 1, tag: 'protocol' },
      {
        id: 'dark-street-context',
        content: snap.content,
        priority: 2,
        tag: 'scenario',
      },
    ],
    contextSections: [],
    budgetTokens: 100_000,
  };
};

const truncate = (v: unknown, n: number): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

type TurnState = {
  readonly assistantText: string;
  readonly lastUsage?: TokenUsage;
};

const main = async (): Promise<void> => {
  const model = buildModelFromEnv();
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const messages: ModelMessage[] = [];

  stderr.write('暗街 × v3 实验 REPL  ——  Ctrl+C 退\n');

  while (true) {
    const line = await rl.question('\n> ').catch(() => null);
    if (line === null) break;
    if (!line.trim()) continue;
    messages.push({ role: 'user', content: line });

    try {
      const { systemPrompt } = packSections(buildSections(messages));
      const turn = await consumeKernel<TurnState>(
        run({ model, system: systemPrompt, messages }),
        {
          'text-delta': (ev, s) => {
            stdout.write(ev.text);
            return { ...s, assistantText: s.assistantText + ev.text };
          },
          'reasoning-delta': (ev, s) => {
            stderr.write(`\x1b[2m${ev.text}\x1b[0m`);
            return s;
          },
          'tool-call': (ev, s) => {
            stdout.write(`\n[tool] ${ev.name}(${truncate(ev.args, 100)})\n`);
            return s;
          },
          'tool-result': (ev, s) => {
            stdout.write(`[done] ${truncate(ev.output, 100)}\n`);
            return s;
          },
          'tool-error': (ev, s) => {
            stdout.write(`[err] ${ev.error}\n`);
            return s;
          },
          'step-finished': (ev, s) => ({ ...s, lastUsage: ev.usage }),
          final: (ev, s) => {
            stdout.write(
              `\n[${ev.finishReason}] ${s.lastUsage?.outputTokens ?? '?'} out tok\n`,
            );
            return s;
          },
        },
        { assistantText: '' },
      );
      messages.push({ role: 'assistant', content: turn.assistantText });

      // Post-turn：parse → update state；展示 choices / state 摘要
      const parsed = parseHtmlProtocol(turn.assistantText);
      if (parsed.stateUpdate !== null) {
        state = { ...state, ...parsed.stateUpdate };
      }
      stderr.write(
        `\n\x1b[2m── frames=${parsed.frames.length} scratch=${parsed.scratches.length} ` +
          `state=${JSON.stringify(state).slice(0, 220)} ` +
          `warnings=${parsed.warnings.length}\x1b[0m\n`,
      );
      if (parsed.warnings.length > 0) {
        for (const w of parsed.warnings) {
          stderr.write(`\x1b[33m  ⚠ ${w}\x1b[0m\n`);
        }
      }
      if (parsed.choices !== null) {
        stderr.write('\n\x1b[36m选项：\x1b[0m\n');
        parsed.choices.options.forEach((opt, i) => {
          stderr.write(`  ${i + 1}. ${opt}\n`);
        });
      }
    } catch (e) {
      stderr.write(
        `\n[error] ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  rl.close();
};

await main();
