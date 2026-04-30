import type { LanguageModel, ModelMessage } from 'ai';

import { run } from '#internal/v3/kernel/driver';
import type { KernelEvent, ToolSet } from '#internal/v3/kernel/types';
import { packSections, type AssembleInput } from '#internal/v3/assemble';
import { collectAllEvents } from '#internal/v3/consume';

export type TurnContext = {
  readonly turn: number;
  readonly messages: readonly ModelMessage[];
  readonly lastAssistant?: string;
};

export type Scenario = {
  readonly id: string;
  readonly initialMessages?: readonly ModelMessage[];
  readonly nextUserInput: (ctx: TurnContext) => Promise<string | null>;
  readonly maxTurns?: number;
};

export type EvalConfig = {
  readonly model: LanguageModel;
  readonly tools?: ToolSet;
  readonly buildSections: (ctx: {
    readonly messages: readonly ModelMessage[];
  }) => AssembleInput;
  readonly scenarios: readonly Scenario[];
  readonly reps?: number;
  readonly outputJsonl?: string;
};

type TurnRecord = {
  readonly turn: number;
  readonly events: readonly KernelEvent[];
};

type ScenarioRunRecord = {
  readonly scenarioId: string;
  readonly rep: number;
  readonly turns: readonly TurnRecord[];
};

const ENV_MAX_TURNS = (() => {
  const v = Bun.env.MAX_TURNS;
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`MAX_TURNS env invalid: ${v}`);
  }
  return n;
})();

const resolveMaxTurns = (scn: Scenario): number => {
  if (scn.maxTurns !== undefined) return scn.maxTurns;
  if (ENV_MAX_TURNS !== undefined) return ENV_MAX_TURNS;
  throw new Error(
    `scenario ${scn.id}: maxTurns 缺失。设 scenario.maxTurns 或 MAX_TURNS env`,
  );
};

const extractAssistantText = (events: readonly KernelEvent[]): string =>
  events
    .filter(
      (e): e is Extract<KernelEvent, { type: 'text-delta' }> =>
        e.type === 'text-delta',
    )
    .map((e) => e.text)
    .join('');

export const runEvalBatch = async (config: EvalConfig): Promise<void> => {
  const records: ScenarioRunRecord[] = [];
  const reps = config.reps ?? 1;

  for (let r = 0; r < reps; r++) {
    for (const scn of config.scenarios) {
      const maxTurns = resolveMaxTurns(scn);
      let messages: ModelMessage[] = [...(scn.initialMessages ?? [])];
      let lastAssistant: string | undefined;
      const turns: TurnRecord[] = [];

      for (let turn = 0; turn < maxTurns; turn++) {
        const userInput = await scn.nextUserInput({
          turn,
          messages,
          lastAssistant,
        });
        if (userInput === null) break;
        messages = [...messages, { role: 'user', content: userInput }];

        let events: readonly KernelEvent[];
        try {
          const { systemPrompt } = packSections(
            config.buildSections({ messages }),
          );
          events = await collectAllEvents(
            run({
              model: config.model,
              tools: config.tools,
              system: systemPrompt,
              messages,
            }),
          );
        } catch (e) {
          events = [
            {
              type: 'final',
              finishReason: 'error',
              toolCallsCompleted: [],
              text: e instanceof Error ? e.message : String(e),
            },
          ];
        }

        const assistantText = extractAssistantText(events);
        turns.push({ turn, events });
        messages = [
          ...messages,
          { role: 'assistant', content: assistantText },
        ];
        lastAssistant = assistantText;
      }

      records.push({ scenarioId: scn.id, rep: r + 1, turns });
      const last = turns.at(-1)?.events.find((e) => e.type === 'final');
      const tag = last?.type === 'final' ? last.finishReason : 'no-final';
      console.error(
        `✓ ${scn.id} rep ${r + 1} → ${turns.length} turns, last=${tag}`,
      );
    }
  }

  const outPath = config.outputJsonl ?? '/tmp/v3-eval.jsonl';
  await Bun.write(
    outPath,
    records.map((r) => JSON.stringify(r)).join('\n') + '\n',
  );
  console.error(`wrote ${outPath}`);
};
