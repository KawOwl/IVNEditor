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
