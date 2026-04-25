import { describe, expect, it } from 'bun:test';
import { runMemoryEvaluationSuite } from '#internal/evaluation/memory-harness';
import type { MemoryConfig, PromptSegment, StateSchema } from '#internal/types';

describe('memory evaluation harness', () => {
  it('runs a scripted input sequence across memory variants', async () => {
    const report = await runMemoryEvaluationSuite({
      scenario: {
        id: 'silver-key',
        segments: [systemSegment],
        stateSchema,
        initialPrompt: '开场。',
        enabledTools: [],
        tokenBudget: 12000,
      },
      variants: [
        { id: 'legacy', memoryConfig: { ...baseMemoryConfig, provider: 'legacy' } },
        {
          id: 'llm-summary',
          memoryConfig: { ...baseMemoryConfig, provider: 'llm-summarizer' },
        },
      ],
      compression: {
        responses: ['Luna 把银钥匙交给玩家；玩家选择收下，并准备继续调查。'],
      },
      script: [
        {
          generate: {
            text: '<narration>Luna 把一枚银钥匙放到你掌心。</narration>',
            toolCalls: [
              {
                name: 'signal_input_needed',
                args: {
                  prompt_hint: '要收下银钥匙吗？',
                  choices: ['收下银钥匙', '先问清来历'],
                },
              },
            ],
          },
          input: '收下银钥匙',
        },
        {
          generate: {
            text: '<narration>你记得银钥匙属于图书馆深处的禁门。</narration>',
            toolCalls: [
              {
                name: 'signal_input_needed',
                args: {
                  prompt_hint: '下一步？',
                  choices: ['去禁门', '回大厅'],
                },
              },
            ],
          },
        },
      ],
    });

    expect(report.comparisons).toEqual([
      {
        variantId: 'legacy',
        status: 'waiting-input',
        turnsRun: 2,
        generatedTexts: [
          '<narration>Luna 把一枚银钥匙放到你掌心。</narration>',
          '<narration>你记得银钥匙属于图书馆深处的禁门。</narration>',
        ],
        inputRequestCount: 2,
        narrativeEntryCount: 5,
        memoryKind: 'legacy',
        memorySummaryCount: 1,
        compressionCallCount: 0,
        finalScene: { background: null, sprites: [] },
        finalStateVars: { current_scene: 'hall' },
      },
      {
        variantId: 'llm-summary',
        status: 'waiting-input',
        turnsRun: 2,
        generatedTexts: [
          '<narration>Luna 把一枚银钥匙放到你掌心。</narration>',
          '<narration>你记得银钥匙属于图书馆深处的禁门。</narration>',
        ],
        inputRequestCount: 2,
        narrativeEntryCount: 5,
        memoryKind: 'llm-summarizer',
        memorySummaryCount: 1,
        compressionCallCount: 1,
        finalScene: { background: null, sprites: [] },
        finalStateVars: { current_scene: 'hall' },
      },
    ]);

    const [legacyRun, llmRun] = report.runs;
    expect(report.runs.every((run) => run.coreEventProtocol.ok)).toBe(true);
    expect(report.runs.every((run) => run.sessionEmitterProjection.ok)).toBe(true);
    expect(legacyRun?.coreEvents.map((event) => event.type)).toContain('waiting-input-started');
    expect(legacyRun?.coreEvents.map((event) => event.type)).toContain('player-input-recorded');
    expect(legacyRun?.recording.inputRequests).toEqual([
      {
        hint: '要收下银钥匙吗？',
        inputType: 'choice',
        choices: ['收下银钥匙', '先问清来历'],
      },
      {
        hint: '下一步？',
        inputType: 'choice',
        choices: ['去禁门', '回大厅'],
      },
    ]);
    expect(llmRun?.memorySnapshot.summaries).toEqual([
      'Luna 把银钥匙交给玩家；玩家选择收下，并准备继续调查。',
    ]);
    expect(llmRun?.llmCalls.map((call) => call.kind)).toEqual([
      'generate',
      'generate',
      'compress',
    ]);
  });
});

const stateSchema: StateSchema = {
  variables: [
    {
      name: 'current_scene',
      type: 'string',
      initial: 'hall',
      description: '当前场景。',
    },
  ],
};

const baseMemoryConfig: MemoryConfig = {
  contextBudget: 4000,
  compressionThreshold: 1,
  recencyWindow: 1,
  compressionHints: '保留银钥匙和玩家选择。',
};

const systemSegment: PromptSegment = {
  id: 'rules',
  label: 'Rules',
  content: '你是互动小说 GM。',
  contentHash: 'rules-hash',
  type: 'content',
  sourceDoc: 'test',
  role: 'system',
  priority: 0,
  tokenCount: 12,
};
