import { describe, expect, it } from 'bun:test';
import { StateStore } from '#internal/state-store';
import { createGenerateTurnRuntime } from '#internal/game-session/generate-turn-runtime';
import {
  createRecordingSessionEmitter,
  type RecordingSessionEmitter,
} from '#internal/game-session/recording-emitter';
import { createLegacySessionEmitterProjection } from '#internal/game-session/legacy-session-emitter-projection';
import type { CoreEventSink } from '#internal/game-session/core-events';
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
    const recording = createRecordingSessionEmitter();
    const llmClient = createLLMDouble(async (options) => {
      options.onStepStart?.({ stepNumber: 0, batchId: 'batch-1', isFollowup: false });
      options.onTextChunk?.('雨停了。');
      options.onReasoningChunk?.('天气观察');
      options.onStep?.(stepInfo({
        batchId: 'batch-1',
        text: '雨停了。',
        reasoning: '天气观察',
        partKinds: ['reasoning', 'text'],
      }));
      return { text: '雨停了。', toolCalls: [], finishReason: 'stop' };
    });

    const result = await createGenerateTurnRuntime({
      turn: 2,
      stateStore,
      memory,
      llmClient,
      segments: [],
      enabledTools: [],
      tokenBudget: 12000,
      persistence,
      coreEventSink: createRecordingProjectionSink(recording),
      protocolVersion: 'v1-tool-call',
      characters: [],
      backgrounds: [],
      currentScene: { background: null, sprites: [] },
      buildRetrievalQuery: async () => '',
      isActive: () => true,
      onScenarioEnd: () => {},
    }).run();

    const output = recording.getSnapshot();

    expect(result).toEqual({
      currentScene: { background: null, sprites: [] },
      pendingSignal: null,
      stopped: false,
    });
    expect(output.streamingEntries).toEqual([
      {
        id: 'recording-stream-1',
        text: '雨停了。',
        reasoning: '天气观察',
        finalized: true,
      },
    ]);
    expect(output.sentences).toEqual([
      {
        kind: 'narration',
        text: '雨停了。',
        sceneRef: { background: null, sprites: [] },
        turnNumber: 2,
        index: 0,
      },
    ]);
    expect(memory.appendedTurns.map((turn) => turn.content)).toEqual(['雨停了。']);
    expect(persistence.narrativeEntries).toEqual([
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
          content: '雨停了。',
          reasoning: undefined,
          finishReason: 'stop',
        },
        batchId: 'batch-1',
      },
    ]);
    expect(persistence.generateCompletes).toEqual([
      {
        memorySnapshot: { entries: [{ role: 'generate', content: '雨停了。' }], summaries: [] },
        preview: '雨停了。',
        currentScene: { background: null, sprites: [] },
      },
    ]);
  });

  it('does not start LLM streaming when the session stops during preparation', async () => {
    const stateStore = new StateStore(emptyStateSchema);
    const memory = createMemoryDouble();
    const recording = createRecordingSessionEmitter();
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
      coreEventSink: createRecordingProjectionSink(recording),
      protocolVersion: 'v1-tool-call',
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
    const recording = createRecordingSessionEmitter();
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
      persistence,
      coreEventSink: createRecordingProjectionSink(recording),
      protocolVersion: 'v1-tool-call',
      characters: [],
      backgrounds: [],
      currentScene: { background: null, sprites: [] },
      buildRetrievalQuery: async () => '',
      isActive: () => true,
      onScenarioEnd: () => {},
    }).run();

    expect(persistence.narrativeEntries).toEqual([
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
    const recording = createRecordingSessionEmitter();
    const llmClient = createLLMDouble(async (options) => {
      options.onStepStart?.({ stepNumber: 0, batchId: 'batch-scene', isFollowup: false });
      options.onTextChunk?.('你走进屋子。');
      options.onReasoningChunk?.('玩家进屋了，先切场景');
      options.onStep?.(stepInfo({
        batchId: 'batch-scene',
        text: '你走进屋子。',
        reasoning: '玩家进屋了，先切场景',
        finishReason: 'tool-calls',
        partKinds: ['reasoning', 'text', 'tool-call'],
        toolCalls: [{ name: 'change_scene', args: { background: 'room' } }],
      }));

      options.onStepStart?.({ stepNumber: 1, batchId: 'batch-signal', isFollowup: false });
      options.onTextChunk?.('沙发上坐着 sakuya。');
      options.onReasoningChunk?.('描绘进屋后的画面 + 提供选项');
      await options.tools['signal_input_needed']!.execute({
        prompt_hint: '接下来呢？',
        choices: ['坐下', '打招呼'],
      });
      options.onStep?.(stepInfo({
        batchId: 'batch-signal',
        text: '沙发上坐着 sakuya。',
        reasoning: '描绘进屋后的画面 + 提供选项',
        finishReason: 'tool-calls',
        partKinds: ['reasoning', 'text', 'tool-call'],
        toolCalls: [{ name: 'signal_input_needed', args: {} }],
      }));
      return {
        text: '你走进屋子。沙发上坐着 sakuya。',
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
      persistence,
      coreEventSink: createRecordingProjectionSink(recording),
      protocolVersion: 'v1-tool-call',
      characters: [],
      backgrounds: [],
      currentScene: { background: null, sprites: [] },
      buildRetrievalQuery: async () => '',
      isActive: () => true,
      onScenarioEnd: () => {},
    }).run();

    expect(result.pendingSignal).toEqual({
      hint: '接下来呢？',
      choices: ['坐下', '打招呼'],
      batchId: 'batch-signal',
    });
    expect(persistence.narrativeEntries).toEqual([
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
          content: '你走进屋子。沙发上坐着 sakuya。',
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
});

const emptyStateSchema: StateSchema = { variables: [] };

function createRecordingProjectionSink(recording: RecordingSessionEmitter): CoreEventSink {
  const projection = createLegacySessionEmitterProjection(recording.emitter);
  return { publish: (event) => projection.publish(event) };
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
  readonly narrativeEntries: Array<Parameters<SessionPersistence['onNarrativeSegmentFinalized']>[0]>;
  readonly generateCompletes: Array<Parameters<SessionPersistence['onGenerateComplete']>[0]>;
}

function createPersistenceDouble(): PersistenceDouble {
  const narrativeEntries: PersistenceDouble['narrativeEntries'] = [];
  const generateCompletes: PersistenceDouble['generateCompletes'] = [];

  return {
    narrativeEntries,
    generateCompletes,
    async onGenerateStart() {},
    async onNarrativeSegmentFinalized(data) {
      narrativeEntries.push(data);
    },
    async onGenerateComplete(data) {
      generateCompletes.push(data);
    },
    async onWaitingInput() {},
    async onReceiveComplete() {},
  };
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
