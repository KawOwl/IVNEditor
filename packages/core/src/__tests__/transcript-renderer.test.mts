/**
 * transcript-renderer —— 把 report 渲染成 markdown 给 LLM judge / 人读
 *
 * 关键覆盖：
 *   - turn 按 turnNumber 升序、turn 内按 index 升序
 *   - dialogue / narration / signal_input / player_input / scene_change 都有形态
 *   - choices 列表带编号；空 choices 显示 freetext
 *   - selectedIndex 在 player input 上正确指出"选了第几个"
 *   - truncated 标记可见
 *   - 多 variant 之间用 `---` 分隔
 */

import { describe, it, expect } from 'bun:test';
import { renderTranscript } from '#internal/evaluation/transcript-renderer';
import type {
  MemoryEvaluationReport,
  MemoryEvaluationRun,
} from '#internal/evaluation/memory-harness';
import type { Sentence } from '#internal/types';

function mkRun(partial: Partial<MemoryEvaluationRun> & Pick<MemoryEvaluationRun, 'variantId'>): MemoryEvaluationRun {
  return {
    variantId: partial.variantId,
    memoryKind: partial.memoryKind ?? 'noop',
    turnsRun: partial.turnsRun ?? 0,
    stopReason: partial.stopReason ?? 'completed-script',
    stateVars: partial.stateVars ?? {},
    currentScene: partial.currentScene ?? { background: null, sprites: [] },
    memorySnapshot: partial.memorySnapshot ?? { kind: 'noop-v1' },
    recording: partial.recording ?? emptyRecording(),
    persistence: partial.persistence ?? {
      generateStarts: [],
      generateCompletes: [],
      waitingInputs: [],
      receiveCompletes: [],
      scenarioFinished: [],
    },
    llmCalls: partial.llmCalls ?? [],
    coreEvents: partial.coreEvents ?? [],
    coreEventEnvelopes: partial.coreEventEnvelopes ?? [],
    coreEventProtocol: partial.coreEventProtocol ?? { ok: true, violations: [] },
    sessionEmitterProjection: partial.sessionEmitterProjection
      ?? { ok: true, mismatches: [], recording: emptyRecording() },
  };
}

function emptyRecording(): MemoryEvaluationRun['recording'] {
  return {
    status: 'finished',
    error: null,
    inputHint: null,
    inputType: 'freetext',
    choices: null,
    statuses: [],
    errors: [],
    streamingEntries: [],
    entries: [],
    toolCalls: [],
    pendingToolCalls: [],
    inputRequests: [],
    pendingDebug: [],
    debugSnapshots: [],
    sentences: [],
    sceneChanges: [],
  };
}

function mkReport(runs: MemoryEvaluationRun[]): MemoryEvaluationReport {
  return {
    scenarioId: 'silver-key',
    runs,
    comparisons: runs.map((r) => ({
      variantId: r.variantId,
      status: r.recording.status,
      turnsRun: r.turnsRun,
      generatedTexts: [],
      inputRequestCount: 0,
      narrativeEntryCount: 0,
      memoryKind: r.memoryKind,
      memorySummaryCount: 0,
      compressionCallCount: 0,
      finalScene: r.currentScene,
      finalStateVars: r.stateVars,
    })),
  };
}

const baseScene = { background: 'library_hall', sprites: [{ id: 'luna', emotion: 'neutral', position: 'center' as const }] };

describe('renderTranscript', () => {
  it('renders header with scenario id and variant ids', () => {
    const out = renderTranscript(mkReport([
      mkRun({ variantId: 'noop' }),
      mkRun({ variantId: 'mem0' }),
    ]));
    expect(out).toContain('# Memory eval transcript: silver-key');
    expect(out).toContain('Variants: noop, mem0');
    expect(out).toContain('## Variant: `noop`');
    expect(out).toContain('## Variant: `mem0`');
  });

  it('separates multiple variants with ---', () => {
    const out = renderTranscript(mkReport([
      mkRun({ variantId: 'a' }),
      mkRun({ variantId: 'b' }),
    ]));
    const dividerCount = (out.match(/^---$/gm) ?? []).length;
    expect(dividerCount).toBeGreaterThanOrEqual(2);
  });

  it('groups sentences by turn and orders by index inside a turn', () => {
    const sentences: Sentence[] = [
      { kind: 'narration', text: 'B', sceneRef: baseScene, turnNumber: 1, index: 1 },
      { kind: 'narration', text: 'A', sceneRef: baseScene, turnNumber: 1, index: 0 },
      { kind: 'narration', text: 'C', sceneRef: baseScene, turnNumber: 2, index: 0 },
    ];
    const out = renderTranscript(mkReport([mkRun({
      variantId: 'noop',
      recording: { ...emptyRecording(), sentences },
    })]));
    // A 在 B 之前（同 turn 内 index 升序），B 在 C 之前（turn 1 在 turn 2 之前）
    const aPos = out.indexOf('A');
    const bPos = out.indexOf('B');
    const cPos = out.indexOf('C');
    expect(aPos).toBeGreaterThan(0);
    expect(bPos).toBeGreaterThan(aPos);
    expect(cPos).toBeGreaterThan(bPos);
    expect(out).toContain('### Turn 1');
    expect(out).toContain('### Turn 2');
  });

  it('renders dialogue with bolded speaker', () => {
    const sentences: Sentence[] = [
      {
        kind: 'dialogue',
        text: '你来了。',
        pf: { speaker: 'luna' },
        sceneRef: baseScene,
        turnNumber: 1,
        index: 0,
      },
    ];
    const out = renderTranscript(mkReport([mkRun({ variantId: 'noop', recording: { ...emptyRecording(), sentences } })]));
    expect(out).toContain('**luna**: 你来了。');
  });

  it('renders narration as plain text and marks truncated', () => {
    const sentences: Sentence[] = [
      { kind: 'narration', text: '夜色已深。', sceneRef: baseScene, turnNumber: 1, index: 0 },
      { kind: 'narration', text: '话还没说完', sceneRef: baseScene, turnNumber: 1, index: 1, truncated: true },
    ];
    const out = renderTranscript(mkReport([mkRun({ variantId: 'noop', recording: { ...emptyRecording(), sentences } })]));
    expect(out).toContain('夜色已深。');
    expect(out).toContain('话还没说完 _…(truncated)_');
  });

  it('renders signal_input with numbered choices', () => {
    const sentences: Sentence[] = [
      {
        kind: 'signal_input',
        hint: '你想做什么？',
        choices: ['收下银钥匙', '拒绝并询问', '转身离开'],
        sceneRef: baseScene,
        turnNumber: 1,
        index: 0,
      },
    ];
    const out = renderTranscript(mkReport([mkRun({ variantId: 'noop', recording: { ...emptyRecording(), sentences } })]));
    expect(out).toContain('[GM signals]** 你想做什么？');
    expect(out).toContain('1. 收下银钥匙');
    expect(out).toContain('2. 拒绝并询问');
    expect(out).toContain('3. 转身离开');
  });

  it('renders signal_input with empty choices as freetext placeholder', () => {
    const sentences: Sentence[] = [
      {
        kind: 'signal_input',
        hint: '你想说什么？',
        choices: [],
        sceneRef: baseScene,
        turnNumber: 1,
        index: 0,
      },
    ];
    const out = renderTranscript(mkReport([mkRun({ variantId: 'noop', recording: { ...emptyRecording(), sentences } })]));
    expect(out).toContain('_(freetext)_');
  });

  it('renders player_input with selectedIndex indicator', () => {
    const sentences: Sentence[] = [
      {
        kind: 'player_input',
        text: '收下银钥匙',
        selectedIndex: 0,
        sceneRef: baseScene,
        turnNumber: 1,
        index: 1,
      },
      {
        kind: 'player_input',
        text: '随便聊聊',
        sceneRef: baseScene,
        turnNumber: 2,
        index: 0,
      },
    ];
    const out = renderTranscript(mkReport([mkRun({ variantId: 'noop', recording: { ...emptyRecording(), sentences } })]));
    expect(out).toContain('**> Player**: 收下银钥匙 _(selected #1)_');
    expect(out).toContain('**> Player**: 随便聊聊 _(freetext)_');
  });

  it('renders scene_change with bg + sprites + optional transition', () => {
    const sentences: Sentence[] = [
      {
        kind: 'scene_change',
        scene: {
          background: 'deep_stacks',
          sprites: [{ id: 'luna', emotion: 'smile', position: 'center' }],
        },
        transition: 'fade',
        turnNumber: 1,
        index: 0,
      },
    ];
    const out = renderTranscript(mkReport([mkRun({ variantId: 'noop', recording: { ...emptyRecording(), sentences } })]));
    expect(out).toContain('bg=deep_stacks');
    expect(out).toContain('luna:smile@center');
    expect(out).toContain('transition=fade');
  });

  it('shows final state in footer', () => {
    const out = renderTranscript(mkReport([mkRun({
      variantId: 'noop',
      stateVars: { has_silver_key: true, current_scene: 'deep_stacks' },
      currentScene: { background: 'deep_stacks', sprites: [] },
    })]));
    expect(out).toContain('### Final state');
    expect(out).toContain('bg=deep_stacks');
    expect(out).toContain('`has_silver_key=true`');
    expect(out).toContain('`current_scene="deep_stacks"`');
  });

  it('shows _(no sentences recorded)_ when sentences is empty', () => {
    const out = renderTranscript(mkReport([mkRun({ variantId: 'noop' })]));
    expect(out).toContain('_(no sentences recorded)_');
  });

  it('counts generate vs compress LLM calls in header', () => {
    const out = renderTranscript(mkReport([mkRun({
      variantId: 'noop',
      llmCalls: [
        { kind: 'generate', index: 1, systemPrompt: 's', messages: [], toolNames: [], outputText: 'x' },
        { kind: 'generate', index: 2, systemPrompt: 's', messages: [], toolNames: [], outputText: 'x' },
        { kind: 'compress', index: 1, systemPrompt: 's', messages: [], toolNames: [], outputText: 'sum' },
      ],
    })]));
    expect(out).toContain('**LLM calls**: 3 (2 generate, 1 compress)');
  });
});
