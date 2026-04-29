import { describe, expect, it } from 'bun:test';
import { StateStore } from '#internal/state-store';
import {
  createGenerateTurnRuntime,
  isActionableDegrade,
  isForbiddenAdhocSuffix,
} from '#internal/game-session/generate-turn-runtime';
import {
  createRecordingSessionOutputSink,
  type RecordingSessionOutputSink,
} from '#internal/game-session/recording-session-output';
import {
  createCoreEventBus,
  type CoreEvent,
  type CoreEventBus,
  type CoreEventSink,
} from '#internal/game-session/core-events';
import { createSessionPersistenceCoreEventSink } from '#internal/game-session/persistence-core-event-sink';
import type { GenerateOptions, GenerateResult, LLMClient, StepInfo } from '#internal/llm-client';
import type { Memory } from '#internal/memory/types';
import type { MemoryEntry, StateSchema } from '#internal/types';
import type { SessionPersistence } from '#internal/game-session/types';

describe('GenerateTurnRuntime', () => {
  it('runs one generate turn and returns output without owning receive input', async () => {
    const stateStore = new StateStore(emptyStateSchema);
    stateStore.setTurn(1);
    const memory = createMemoryDouble();
    const persistence = createPersistenceDouble();
    const recording = createRecordingSessionOutputSink();
    const coreEvents: CoreEvent[] = [];
    const coreEventSink = createTestCoreEventSink(recording, persistence, coreEvents);
    const llmClient = createLLMDouble(async (options) => {
      options.onStepStart?.({ stepNumber: 0, batchId: 'batch-1', isFollowup: false });
      options.onTextChunk?.('<narration>雨停了。</narration>');
      options.onReasoningChunk?.('天气观察');
      options.onStep?.(stepInfo({
        batchId: 'batch-1',
        text: '<narration>雨停了。</narration>',
        reasoning: '天气观察',
        partKinds: ['reasoning', 'text'],
      }));
      return { text: '<narration>雨停了。</narration>', toolCalls: [], finishReason: 'stop' };
    });

    const result = await createGenerateTurnRuntime({
      turn: 2,
      stateStore,
      memory,
      llmClient,
      segments: [],
      enabledTools: [],
      tokenBudget: 12000,
      coreEventSink,
      ...runtimeProtocolConfig(),
      characters: [],
      backgrounds: [],
      currentScene: { background: null, sprites: [] },
      buildRetrievalQuery: async () => '',
      isActive: () => true,
      onScenarioEnd: () => {},
    }).run();
    await coreEventSink.flushDurable();

    const output = recording.getSnapshot();

    expect(result).toEqual({
      currentScene: { background: null, sprites: [] },
      pendingSignal: null,
      stopped: false,
    });
    expect(output.streamingEntries).toEqual([
      {
        id: 'recording-stream-1',
        text: '<narration>雨停了。</narration>',
        reasoning: '天气观察',
        finalized: true,
      },
    ]);
    expect(output.sentences).toEqual([
      {
        kind: 'narration',
        text: '雨停了。',
        sceneRef: { background: null, sprites: [] },
        bgChanged: false,
        spritesChanged: false,
        turnNumber: 2,
        index: 0,
      },
    ]);
    expect(memory.appendedTurns.map((turn) => turn.content)).toEqual([
      '<narration>雨停了。</narration>',
    ]);
    expect(narrativeSegments(coreEvents)).toEqual([
      {
        entry: {
          role: 'generate',
          content: '',
          reasoning: '天气观察',
          finishReason: 'stop',
        },
        batchId: 'batch-1',
      },
      {
        entry: {
          role: 'generate',
          content: '<narration>雨停了。</narration>',
          reasoning: undefined,
          finishReason: 'stop',
        },
        batchId: 'batch-1',
      },
    ]);
    expect(persistence.generateCompletes).toEqual([
      {
        memorySnapshot: { entries: [{ role: 'generate', content: '<narration>雨停了。</narration>' }], summaries: [] },
        preview: '雨停了。',
        currentScene: { background: null, sprites: [] },
      },
    ]);
  });

  it('does not expose legacy visual tools in the current runtime', async () => {
    const stateStore = new StateStore(emptyStateSchema);
    const memory = createMemoryDouble();
    const recording = createRecordingSessionOutputSink();
    const llmClient = createLLMDouble(async (options) => {
      expect(options.tools['change_scene']).toBeUndefined();
      expect(options.tools['change_sprite']).toBeUndefined();
      expect(options.tools['clear_stage']).toBeUndefined();
      return { text: '', toolCalls: [], finishReason: 'stop' };
    });

    await createGenerateTurnRuntime({
      turn: 1,
      stateStore,
      memory,
      llmClient,
      segments: [],
      enabledTools: ['change_scene', 'change_sprite', 'clear_stage'],
      tokenBudget: 12000,
      coreEventSink: recording,
      ...runtimeProtocolConfig(),
      characters: [],
      backgrounds: [],
      currentScene: { background: null, sprites: [] },
      buildRetrievalQuery: async () => '',
      isActive: () => true,
      onScenarioEnd: () => {},
    }).run();
  });

  it('does not start LLM streaming when the session stops during preparation', async () => {
    const stateStore = new StateStore(emptyStateSchema);
    const memory = createMemoryDouble();
    const recording = createRecordingSessionOutputSink();
    let generateCalled = false;
    const llmClient = createLLMDouble(async () => {
      generateCalled = true;
      return { text: '', toolCalls: [], finishReason: 'stop' };
    });

    const result = await createGenerateTurnRuntime({
      turn: 1,
      stateStore,
      memory,
      llmClient,
      segments: [],
      enabledTools: [],
      tokenBudget: 12000,
      coreEventSink: recording,
      ...runtimeProtocolConfig(),
      characters: [],
      backgrounds: [],
      currentScene: { background: null, sprites: [] },
      buildRetrievalQuery: async () => '',
      isActive: () => false,
      onScenarioEnd: () => {},
    }).run();

    expect(result).toEqual({
      currentScene: { background: null, sprites: [] },
      pendingSignal: null,
      stopped: true,
    });
    expect(generateCalled).toBe(false);
    expect(recording.getSnapshot().streamingEntries).toEqual([]);
  });

  it('persists reasoning stubs for tool-only main steps', async () => {
    const stateStore = new StateStore(emptyStateSchema);
    const memory = createMemoryDouble();
    const persistence = createPersistenceDouble();
    const recording = createRecordingSessionOutputSink();
    const coreEvents: CoreEvent[] = [];
    const coreEventSink = createTestCoreEventSink(recording, persistence, coreEvents);
    const llmClient = createLLMDouble(async (options) => {
      options.onStepStart?.({ stepNumber: 0, batchId: 'batch-tool', isFollowup: false });
      options.onReasoningChunk?.('先切场景再写状态');
      options.onStep?.(stepInfo({
        batchId: 'batch-tool',
        text: '',
        reasoning: '先切场景再写状态',
        finishReason: 'tool-calls',
        partKinds: ['reasoning', 'tool-call'],
        toolCalls: [{ name: 'update_state', args: { chapter: 2 } }],
      }));
      return { text: '', toolCalls: [], finishReason: 'tool-calls' };
    });

    await createGenerateTurnRuntime({
      turn: 1,
      stateStore,
      memory,
      llmClient,
      segments: [],
      enabledTools: [],
      tokenBudget: 12000,
      coreEventSink,
      ...runtimeProtocolConfig(),
      characters: [],
      backgrounds: [],
      currentScene: { background: null, sprites: [] },
      buildRetrievalQuery: async () => '',
      isActive: () => true,
      onScenarioEnd: () => {},
    }).run();
    await coreEventSink.flushDurable();

    expect(narrativeSegments(coreEvents)).toEqual([
      {
        entry: {
          role: 'generate',
          content: '',
          reasoning: '先切场景再写状态',
          finishReason: 'tool-calls',
        },
        batchId: 'batch-tool',
      },
    ]);
    expect(memory.appendedTurns).toEqual([]);
  });

  it('persists reasoning stubs for narrative+tool steps and keeps preflush reasoning empty', async () => {
    const stateStore = new StateStore(emptyStateSchema);
    const memory = createMemoryDouble();
    const persistence = createPersistenceDouble();
    const recording = createRecordingSessionOutputSink();
    const coreEvents: CoreEvent[] = [];
    const coreEventSink = createTestCoreEventSink(recording, persistence, coreEvents);
    const llmClient = createLLMDouble(async (options) => {
      options.onStepStart?.({ stepNumber: 0, batchId: 'batch-scene', isFollowup: false });
      options.onTextChunk?.('<narration>你走进屋子。</narration>');
      options.onReasoningChunk?.('玩家进屋了，先切场景');
      options.onStep?.(stepInfo({
        batchId: 'batch-scene',
        text: '<narration>你走进屋子。</narration>',
        reasoning: '玩家进屋了，先切场景',
        finishReason: 'tool-calls',
        partKinds: ['reasoning', 'text', 'tool-call'],
        toolCalls: [{ name: 'change_scene', args: { background: 'room' } }],
      }));

      options.onStepStart?.({ stepNumber: 1, batchId: 'batch-signal', isFollowup: false });
      options.onTextChunk?.('<narration>沙发上坐着 sakuya。</narration>');
      options.onReasoningChunk?.('描绘进屋后的画面 + 提供选项');
      await options.tools['signal_input_needed']!.execute({
        prompt_hint: '接下来呢？',
        choices: ['坐下', '打招呼'],
      });
      options.onStep?.(stepInfo({
        batchId: 'batch-signal',
        text: '<narration>沙发上坐着 sakuya。</narration>',
        reasoning: '描绘进屋后的画面 + 提供选项',
        finishReason: 'tool-calls',
        partKinds: ['reasoning', 'text', 'tool-call'],
        toolCalls: [{ name: 'signal_input_needed', args: {} }],
      }));
      return {
        text: '<narration>你走进屋子。</narration><narration>沙发上坐着 sakuya。</narration>',
        toolCalls: [],
        finishReason: 'tool-calls',
      };
    });

    const result = await createGenerateTurnRuntime({
      turn: 1,
      stateStore,
      memory,
      llmClient,
      segments: [],
      enabledTools: [],
      tokenBudget: 12000,
      coreEventSink,
      ...runtimeProtocolConfig(),
      characters: [],
      backgrounds: [],
      currentScene: { background: null, sprites: [] },
      buildRetrievalQuery: async () => '',
      isActive: () => true,
      onScenarioEnd: () => {},
    }).run();
    await coreEventSink.flushDurable();

    expect(result.pendingSignal).toEqual({
      hint: '接下来呢？',
      choices: ['坐下', '打招呼'],
      batchId: 'batch-signal',
    });
    expect(narrativeSegments(coreEvents)).toEqual([
      {
        entry: {
          role: 'generate',
          content: '',
          reasoning: '玩家进屋了，先切场景',
          finishReason: 'tool-calls',
        },
        batchId: 'batch-scene',
      },
      {
        entry: {
          role: 'generate',
          content: '<narration>你走进屋子。</narration><narration>沙发上坐着 sakuya。</narration>',
          reasoning: undefined,
          finishReason: 'signal-input-preflush',
        },
        batchId: 'batch-signal',
      },
      {
        entry: {
          role: 'generate',
          content: '',
          reasoning: '描绘进屋后的画面 + 提供选项',
          finishReason: 'tool-calls',
        },
        batchId: 'batch-signal',
      },
    ]);
  });

  it('rejects legacy-readable v1 as a runtime protocol', () => {
    const stateStore = new StateStore(emptyStateSchema);
    const memory = createMemoryDouble();
    const recording = createRecordingSessionOutputSink();
    const llmClient = createLLMDouble(async () => ({ text: '', toolCalls: [], finishReason: 'stop' }));

    expect(() => createGenerateTurnRuntime({
      turn: 1,
      stateStore,
      memory,
      llmClient,
      segments: [],
      enabledTools: [],
      tokenBudget: 12000,
      coreEventSink: recording,
      protocolVersion: 'v1-tool-call',
      characters: [],
      backgrounds: [],
      currentScene: { background: null, sprites: [] },
      buildRetrievalQuery: async () => '',
      isActive: () => true,
      onScenarioEnd: () => {},
    })).toThrow(/legacy-readable only/);
  });

  // ==========================================================================
  // S.1 streaming：onTextChunk 直接 feed parser-v2 + 立即 publish batch
  //
  // 关键不变量：玩家不需要等到整个 step 流完才看到第一个 sentence。把
  // narrative 拆成多个 chunk，断言：
  //   1. chunk 1 之后 narrative-batch-emitted ≥ 1 条
  //   2. 后续 chunk 持续追加 batch
  //   3. completeGenerateTurn 跑 skipped-streamed 分支（rewriter 不被触发）
  // ==========================================================================
  it('S.1：onTextChunk 产生的 narrative-batch-emitted 在 step 完成前已发出', async () => {
    const stateStore = new StateStore(emptyStateSchema);
    stateStore.setTurn(1);
    const memory = createMemoryDouble();
    const persistence = createPersistenceDouble();
    const recording = createRecordingSessionOutputSink();
    const coreEvents: CoreEvent[] = [];
    const coreEventSink = createTestCoreEventSink(recording, persistence, coreEvents);

    let batchEventsAfterChunk1 = 0;
    let batchEventsAfterChunk2 = 0;

    const fullText = '<narration>雨停了。</narration><narration>风也住了。</narration>';

    const llmClient = createLLMDouble(async (options) => {
      options.onStepStart?.({ stepNumber: 0, batchId: 'batch-1', isFollowup: false });

      options.onTextChunk?.('<narration>雨停了。</narration>');
      batchEventsAfterChunk1 = coreEvents.filter((e) => e.type === 'narrative-batch-emitted').length;

      options.onTextChunk?.('<narration>风也住了。</narration>');
      batchEventsAfterChunk2 = coreEvents.filter((e) => e.type === 'narrative-batch-emitted').length;

      options.onStep?.(stepInfo({
        batchId: 'batch-1',
        text: fullText,
        partKinds: ['text'],
      }));
      return { text: fullText, toolCalls: [], finishReason: 'stop' };
    });

    await createGenerateTurnRuntime({
      turn: 2,
      stateStore,
      memory,
      llmClient,
      segments: [],
      enabledTools: [],
      tokenBudget: 12000,
      coreEventSink,
      ...runtimeProtocolConfig(),
      characters: [],
      backgrounds: [],
      currentScene: { background: null, sprites: [] },
      buildRetrievalQuery: async () => '',
      isActive: () => true,
      onScenarioEnd: () => {},
    }).run();
    await coreEventSink.flushDurable();

    // 关键：streaming 行为——chunk 1 处理完已经至少 publish 了 1 条 batch
    expect(batchEventsAfterChunk1).toBeGreaterThanOrEqual(1);
    expect(batchEventsAfterChunk2).toBeGreaterThan(batchEventsAfterChunk1);

    // 总共 2 条 batch（两个独立 narration）
    const allBatchEvents = coreEvents.filter(
      (e): e is Extract<CoreEvent, { type: 'narrative-batch-emitted' }> =>
        e.type === 'narrative-batch-emitted',
    );
    expect(allBatchEvents.length).toBe(2);
    expect(allBatchEvents.flatMap((e) => e.sentences.map((s) => s.text))).toEqual([
      '雨停了。', '风也住了。',
    ]);

    // rewrite-completed 走 skipped-streamed 路径
    const rewriteCompleted = coreEvents.find(
      (e): e is Extract<CoreEvent, { type: 'rewrite-completed' }> =>
        e.type === 'rewrite-completed',
    );
    expect(rewriteCompleted).toBeDefined();
    expect(rewriteCompleted!.status).toBe('skipped-streamed');
    expect(rewriteCompleted!.verifiedSentenceCount).toBe(2);
    expect(rewriteCompleted!.applied).toBe(false);

    // recording 仍然拿到两个 sentence
    expect(recording.getSnapshot().sentences.map((s) => s.text)).toEqual([
      '雨停了。', '风也住了。',
    ]);
  });

  it('S.1：tag 跨 chunk 边界劈开仍能解析（htmlparser2 streaming buffer）', async () => {
    // 故意把 `<narrat` 和 `ion>...` 劈到两个 chunk，断言 sentence 仍然
    // 正确产出——这是 streaming 路径的鲁棒性底线。
    const stateStore = new StateStore(emptyStateSchema);
    stateStore.setTurn(1);
    const memory = createMemoryDouble();
    const recording = createRecordingSessionOutputSink();
    const coreEvents: CoreEvent[] = [];
    const coreEventSink = createTestCoreEventSink(recording, createPersistenceDouble(), coreEvents);

    const fullText = '<narration>跨 chunk 边界。</narration>';

    const llmClient = createLLMDouble(async (options) => {
      options.onStepStart?.({ stepNumber: 0, batchId: 'batch-1', isFollowup: false });

      // 在 tag 中间劈开：'<narr' + 'ation>跨 chunk 边界。</narrat' + 'ion>'
      options.onTextChunk?.('<narr');
      options.onTextChunk?.('ation>跨 chunk 边界。</narrat');
      options.onTextChunk?.('ion>');

      options.onStep?.(stepInfo({
        batchId: 'batch-1',
        text: fullText,
        partKinds: ['text'],
      }));
      return { text: fullText, toolCalls: [], finishReason: 'stop' };
    });

    await createGenerateTurnRuntime({
      turn: 1,
      stateStore,
      memory,
      llmClient,
      segments: [],
      enabledTools: [],
      tokenBudget: 12000,
      coreEventSink,
      ...runtimeProtocolConfig(),
      characters: [],
      backgrounds: [],
      currentScene: { background: null, sprites: [] },
      buildRetrievalQuery: async () => '',
      isActive: () => true,
      onScenarioEnd: () => {},
    }).run();
    await coreEventSink.flushDurable();

    const allBatchEvents = coreEvents.filter(
      (e): e is Extract<CoreEvent, { type: 'narrative-batch-emitted' }> =>
        e.type === 'narrative-batch-emitted',
    );
    const sentences = allBatchEvents.flatMap((e) => e.sentences);
    expect(sentences.length).toBe(1);
    expect(sentences[0].kind).toBe('narration');
    if (sentences[0].kind === 'narration') {
      expect(sentences[0].text).toBe('跨 chunk 边界。');
    }
  });

  it('S.1 fallback：streaming 没产出 sentence 时仍走原 finalizeContent 路径', async () => {
    // GM 输出全是 scratch / 空白——streaming pass sentenceCount = 0；不应进
    // skipped-streamed 分支，而是 fall back 到 finalizeContent（rewriter 在
    // sentenceCount === 0 时仍可能救场；本 test 没注入 rewriter，所以走
    // E 路径 finalText=raw, finalAnalysis=null，narrative-batch-emitted 数为
    // streaming pass 已 publish 的 scratch-only batches）。
    const stateStore = new StateStore(emptyStateSchema);
    stateStore.setTurn(1);
    const memory = createMemoryDouble();
    const recording = createRecordingSessionOutputSink();
    const coreEvents: CoreEvent[] = [];
    const coreEventSink = createTestCoreEventSink(recording, createPersistenceDouble(), coreEvents);

    const llmClient = createLLMDouble(async (options) => {
      options.onStepStart?.({ stepNumber: 0, batchId: 'batch-1', isFollowup: false });
      options.onTextChunk?.('<scratch>仅模型可见的元思考</scratch>');
      options.onStep?.(stepInfo({
        batchId: 'batch-1',
        text: '<scratch>仅模型可见的元思考</scratch>',
        partKinds: ['text'],
      }));
      return {
        text: '<scratch>仅模型可见的元思考</scratch>',
        toolCalls: [],
        finishReason: 'stop',
      };
    });

    await createGenerateTurnRuntime({
      turn: 1,
      stateStore,
      memory,
      llmClient,
      segments: [],
      enabledTools: [],
      tokenBudget: 12000,
      coreEventSink,
      ...runtimeProtocolConfig(),
      characters: [],
      backgrounds: [],
      currentScene: { background: null, sprites: [] },
      buildRetrievalQuery: async () => '',
      isActive: () => true,
      onScenarioEnd: () => {},
    }).run();
    await coreEventSink.flushDurable();

    // streaming 没产出 sentence —— rewrite-completed **不应**该是 'skipped-streamed'。
    // 没注入 rewriter（runtimeProtocolConfig 不带 rewriter），finalizeContent 走
    // E 路径直接返回 raw，不发任何 rewrite-* 事件。
    const rewriteCompleted = coreEvents.find(
      (e): e is Extract<CoreEvent, { type: 'rewrite-completed' }> =>
        e.type === 'rewrite-completed',
    );
    expect(rewriteCompleted).toBeUndefined();

    // recording 没有 narrative sentence，但 scratch 仍然被 streaming pass publish 了
    expect(recording.getSnapshot().sentences).toEqual([]);
  });
});

const emptyStateSchema: StateSchema = { variables: [] };

function createTestCoreEventSink(
  recording: RecordingSessionOutputSink,
  persistence: SessionPersistence,
  coreEvents: CoreEvent[] = [],
): CoreEventBus {
  const capture: CoreEventSink = {
    publish(event) {
      coreEvents.push(structuredClone(event));
    },
  };

  return createCoreEventBus([
    capture,
    createSessionPersistenceCoreEventSink(persistence),
    recording,
  ]);
}

function runtimeProtocolConfig() {
  return {
    protocolVersion: 'v2-declarative-visual' as const,
    parserManifest: {
      characters: new Set<string>(),
      moodsByChar: new Map<string, ReadonlySet<string>>(),
      backgrounds: new Set<string>(),
    },
  };
}

type AppendedTurn = Parameters<Memory['appendTurn']>[0];

interface MemoryDouble extends Memory {
  readonly appendedTurns: AppendedTurn[];
}

function createMemoryDouble(): MemoryDouble {
  const appendedTurns: AppendedTurn[] = [];

  return {
    kind: 'memory-double',
    appendedTurns,
    async appendTurn(params) {
      appendedTurns.push(params);
      return memoryEntryFrom(params);
    },
    async pin(content, tags) {
      return memoryEntryFrom({ turn: 0, role: 'system', content, tokenCount: 0, tags });
    },
    async retrieve() {
      return { summary: '', entries: [] };
    },
    async getRecentAsMessages() {
      return { messages: [], tokensUsed: 0 };
    },
    async maybeCompact() {},
    async snapshot() {
      return {
        entries: appendedTurns.map((turn) => ({ role: turn.role, content: turn.content })),
        summaries: [],
      };
    },
    async restore() {},
    async reset() {
      appendedTurns.length = 0;
    },
  };
}

function memoryEntryFrom(params: AppendedTurn): MemoryEntry {
  return {
    id: `memory-${params.turn}-${params.role}-${params.content.length}`,
    turn: params.turn,
    role: params.role,
    content: params.content,
    tokenCount: params.tokenCount,
    timestamp: 0,
    ...(params.tags ? { tags: params.tags } : {}),
  };
}

interface PersistenceDouble extends SessionPersistence {
  readonly generateCompletes: Array<Parameters<SessionPersistence['onGenerateComplete']>[0]>;
}

function createPersistenceDouble(): PersistenceDouble {
  const generateCompletes: PersistenceDouble['generateCompletes'] = [];

  return {
    generateCompletes,
    async onGenerateStart() {},
    async onGenerateComplete(data) {
      generateCompletes.push(data);
    },
    async onWaitingInput() {},
    async onReceiveComplete() {},
  };
}

function narrativeSegments(events: readonly CoreEvent[]): Array<{
  entry: Extract<CoreEvent, { type: 'narrative-segment-finalized' }>['entry'];
  batchId: string | null;
}> {
  return events
    .filter((event): event is Extract<CoreEvent, { type: 'narrative-segment-finalized' }> =>
      event.type === 'narrative-segment-finalized')
    .map((event) => ({
      entry: event.entry,
      batchId: event.batchId,
    }));
}

function createLLMDouble(
  generate: (options: GenerateOptions) => Promise<GenerateResult>,
): Pick<LLMClient, 'generate'> {
  return { generate };
}

function stepInfo(
  patch: Pick<StepInfo, 'batchId' | 'text'> & Partial<StepInfo>,
): StepInfo {
  return {
    stepNumber: 0,
    text: patch.text,
    finishReason: patch.finishReason ?? 'stop',
    toolCalls: patch.toolCalls ?? [],
    partKinds: patch.partKinds ?? ['text'],
    batchId: patch.batchId,
    isFollowup: patch.isFollowup ?? false,
    ...(patch.reasoning !== undefined ? { reasoning: patch.reasoning } : {}),
  };
}

// 改进 D（trace f6a68324 触发）：actionable degrade 分类逻辑
describe('isForbiddenAdhocSuffix', () => {
  it('合规身份描述 / 形容词 → false', () => {
    expect(isForbiddenAdhocSuffix('__npc__保安')).toBe(false);
    expect(isForbiddenAdhocSuffix('__npc__老板')).toBe(false);
    expect(isForbiddenAdhocSuffix('__npc__红衣男人')).toBe(false);
    expect(isForbiddenAdhocSuffix('__npc__陌生男声')).toBe(false);
    expect(isForbiddenAdhocSuffix('__npc__戴眼镜的女学生')).toBe(false);
    expect(isForbiddenAdhocSuffix('__npc__裁缝女人')).toBe(false);
  });

  it('关系代词后缀 → true', () => {
    expect(isForbiddenAdhocSuffix('__npc__另一人')).toBe(true);
    expect(isForbiddenAdhocSuffix('__npc__某人')).toBe(true);
    expect(isForbiddenAdhocSuffix('__npc__其中一个')).toBe(true);
    expect(isForbiddenAdhocSuffix('__npc__那个人')).toBe(true);
    expect(isForbiddenAdhocSuffix('__npc__谁')).toBe(true);
  });

  it('人称代词后缀 → true', () => {
    // '我' 不在禁止列表（某些剧本里"我"是 NPC 自述合法称呼）
    for (const p of ['你', '他', '她', '它', '他们', '她们', '咱', '自己', '主角']) {
      expect(isForbiddenAdhocSuffix(`__npc__${p}`)).toBe(true);
    }
  });

  it('"我" 后缀 → false（允许 NPC 自述场景）', () => {
    expect(isForbiddenAdhocSuffix('__npc__我')).toBe(false);
    expect(isForbiddenAdhocSuffix('我')).toBe(false);
  });

  it('不带 __npc__ 前缀的纯后缀也判定（防御性）', () => {
    expect(isForbiddenAdhocSuffix('另一人')).toBe(true);
    expect(isForbiddenAdhocSuffix('保安')).toBe(false);
  });

  it('空 / undefined → false', () => {
    expect(isForbiddenAdhocSuffix(undefined)).toBe(false);
    expect(isForbiddenAdhocSuffix('')).toBe(false);
  });
});

describe('isActionableDegrade', () => {
  it('dialogue-adhoc-speaker + 合规身份 → 不 actionable（rewrite skip）', () => {
    expect(isActionableDegrade({ code: 'dialogue-adhoc-speaker', detail: '__npc__保安' })).toBe(false);
    expect(isActionableDegrade({ code: 'dialogue-adhoc-speaker', detail: '__npc__陌生男声' })).toBe(false);
    expect(isActionableDegrade({ code: 'dialogue-adhoc-speaker', detail: '__npc__裁缝女人' })).toBe(false);
  });

  it('dialogue-adhoc-speaker + 关系代词后缀 → actionable', () => {
    expect(isActionableDegrade({ code: 'dialogue-adhoc-speaker', detail: '__npc__另一人' })).toBe(true);
    expect(isActionableDegrade({ code: 'dialogue-adhoc-speaker', detail: '__npc__某人' })).toBe(true);
    expect(isActionableDegrade({ code: 'dialogue-adhoc-speaker', detail: '__npc__你' })).toBe(true);
  });

  it('container-truncated → 不 actionable（rewriter 不能补内容）', () => {
    expect(isActionableDegrade({ code: 'container-truncated', detail: 'narration' })).toBe(false);
    expect(isActionableDegrade({ code: 'container-truncated', detail: 'dialogue' })).toBe(false);
  });

  it('其他 degrade code → actionable', () => {
    expect(isActionableDegrade({ code: 'bare-text-outside-container', detail: 'some text' })).toBe(true);
    expect(isActionableDegrade({ code: 'unknown-toplevel-tag', detail: 'signal_input_needed' })).toBe(true);
    expect(isActionableDegrade({ code: 'unknown-close-tag', detail: 'narrtion' })).toBe(true);
    expect(isActionableDegrade({ code: 'sprite-unknown-char', detail: 'ghost' })).toBe(true);
    expect(isActionableDegrade({ code: 'sprite-invalid-position', detail: 'top' })).toBe(true);
  });
});
