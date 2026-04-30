import * as readline from 'node:readline/promises';
import { stdin, stdout, stderr } from 'process';
import type { LanguageModel, ModelMessage } from 'ai';

import { run } from '#internal/v3/kernel/driver';
import type { TokenUsage, ToolSet } from '#internal/v3/kernel/types';
import { packSections, type AssembleInput } from '#internal/v3/assemble';
import { consumeKernel } from '#internal/v3/consume';

export type ReplConfig = {
  readonly model: LanguageModel;
  readonly tools?: ToolSet;
  readonly buildSections: (ctx: {
    readonly messages: readonly ModelMessage[];
  }) => AssembleInput;
};

type TurnState = {
  readonly assistantText: string;
  readonly lastUsage?: TokenUsage;
};

const truncate = (v: unknown, n: number): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

export const startRepl = async (config: ReplConfig): Promise<void> => {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const messages: ModelMessage[] = [];

  while (true) {
    const line = await rl.question('> ').catch(() => null);
    if (line === null) break;
    if (!line.trim()) continue;
    messages.push({ role: 'user', content: line });

    try {
      const { systemPrompt } = packSections(config.buildSections({ messages }));
      const turn = await consumeKernel<TurnState>(
        run({
          model: config.model,
          tools: config.tools,
          system: systemPrompt,
          messages,
        }),
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
    } catch (e) {
      stderr.write(
        `\n[error] ${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  rl.close();
};
