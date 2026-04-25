/**
 * Memory evaluation harness
 *
 * Runs deterministic generate/receive scripts through the core generate runtime
 * with a CoreEvent-native session output recorder and an in-memory narrative history store.
 * This gives memory providers the same canonical narrative_entries reader shape
 * they see in server runtime, without WebSocket, DOM, or live LLM calls.
 */

import { computeFocus } from '#internal/focus';
import { createGenerateTurnRuntime } from '#internal/game-session/generate-turn-runtime';
import { computeReceivePayload } from '#internal/game-session/input-payload';
import type {
  BatchId,
  CoreEvent,
  CoreEventEnvelope,
  CoreEventBus,
  CoreEventSink,
} from '#internal/game-session/core-events';
import {
  batchId as toBatchId,
  createDurableFirstCoreEventSink,
  createInputRequest,
  inputRequestId as toInputRequestId,
  turnId as toTurnId,
} from '#internal/game-session/core-events';
import { validateCoreEventSequence, type CoreEventProtocolReport } from '#internal/game-session/core-event-protocol';
import {
  createSessionPersistenceCoreEventSink,
  isSessionPersistenceCoreEvent,
} from '#internal/game-session/persistence-core-event-sink';
import { createRecordingCoreEventSink } from '#internal/game-session/recording-core-events';
import {
  createRecordingSessionEmitter,
  type RecordedSessionOutput,
} from '#internal/game-session/recording-emitter';
import {
  createRecordingSessionOutputSink,
} from '#internal/game-session/recording-session-output';
import { createLegacySessionEmitterProjection } from '#internal/game-session/legacy-session-emitter-projection';
import type { SessionPersistence } from '#internal/game-session/types';
import { LLMClient, type GenerateOptions, type GenerateResult, type LLMConfig, type StepInfo } from '#internal/llm-client';
import { createMemory } from '#internal/memory/factory';
import type {
  CreateMemoryOptions,
  Memory,
  MemorySnapshot,
} from '#internal/memory/types';
import type { NarrativeHistoryReader } from '#internal/memory/narrative-reader';
import { buildParserManifest, type ParserManifest } from '#internal/narrative-parser-v2';
import type { EntryKind, NarrativeEntry } from '#internal/persistence-entry';
import { resolveRuntimeProtocolVersion } from '#internal/protocol-version';
import { StateStore } from '#internal/state-store';
import { estimateTokens } from '#internal/tokens';
import type {
  BackgroundAsset,
  CharacterAsset,
  MemoryConfig,
  PromptSegment,
  ProtocolVersion,
  SceneState,
  StateSchema,
  ToolCallEntry,
} from '#internal/types';

type GenerateCompleteRecord = Parameters<SessionPersistence['onGenerateComplete']>[0];
type WaitingInputRecord = Parameters<SessionPersistence['onWaitingInput']>[0];
type ReceiveCompleteRecord = Parameters<SessionPersistence['onReceiveComplete']>[0];
type ScenarioFinishedRecord = Parameters<NonNullable<SessionPersistence['onScenarioFinished']>>[0];
type ScriptedInput = string | { readonly text: string };
type MemoryEvaluationStopReason =
  | 'completed-script'
  | 'scenario-finished'
  | 'stopped'
  | 'waiting-for-unscripted-input';

export interface MemoryEvaluationScenario {
  readonly id: string;
  readonly playthroughId?: string;
  readonly userId?: string;
  readonly chapterId?: string;
  readonly segments: ReadonlyArray<PromptSegment>;
  readonly stateSchema: StateSchema;
  readonly initialPrompt?: string;
  readonly enabledTools?: ReadonlyArray<string>;
  readonly tokenBudget?: number;
  readonly assemblyOrder?: ReadonlyArray<string>;
  readonly disabledSections?: ReadonlyArray<string>;
  readonly defaultScene?: SceneState;
  readonly protocolVersion?: ProtocolVersion;
  readonly parserManifest?: ParserManifest;
  readonly characters?: ReadonlyArray<CharacterAsset>;
  readonly backgrounds?: ReadonlyArray<BackgroundAsset>;
}

export interface MemoryEvaluationVariant {
  readonly id: string;
  readonly memoryConfig: MemoryConfig;
  readonly mem0ApiKey?: string;
  readonly memoryFactory?: (options: CreateMemoryOptions) => Promise<Memory>;
}

export interface ScriptedToolCall {
  readonly name: string;
  readonly args: unknown;
}

export interface ScriptedGenerateTurn {
  readonly text?: string | ReadonlyArray<string>;
  readonly reasoning?: string | ReadonlyArray<string>;
  readonly toolCalls?: ReadonlyArray<ScriptedToolCall>;
  readonly finishReason?: string;
  readonly model?: string;
}

export interface MemoryEvaluationScriptTurn {
  readonly generate: ScriptedGenerateTurn;
  readonly input?: ScriptedInput;
}

export interface ScriptedCompressionFixture {
  readonly responses?: ReadonlyArray<string>;
  readonly defaultResponse?: string;
}

export interface MemoryEvaluationOptions {
  readonly scenario: MemoryEvaluationScenario;
  readonly variants: ReadonlyArray<MemoryEvaluationVariant>;
  readonly script: ReadonlyArray<MemoryEvaluationScriptTurn>;
  readonly compression?: ScriptedCompressionFixture;
}

export interface LiveMemoryEvaluationOptions {
  readonly scenario: MemoryEvaluationScenario;
  readonly variants: ReadonlyArray<MemoryEvaluationVariant>;
  readonly llmConfig: LLMConfig;
  readonly inputs: ReadonlyArray<ScriptedInput>;
  readonly maxTurns?: number;
}

export interface MemoryEvaluationPersistenceSnapshot {
  readonly entries: ReadonlyArray<NarrativeEntry>;
  readonly generateStarts: ReadonlyArray<number>;
  readonly generateCompletes: ReadonlyArray<GenerateCompleteRecord>;
  readonly waitingInputs: ReadonlyArray<WaitingInputRecord>;
  readonly receiveCompletes: ReadonlyArray<ReceiveCompleteRecord>;
  readonly scenarioFinished: ReadonlyArray<ScenarioFinishedRecord>;
}

export interface ScriptedLLMCall {
  readonly kind: 'generate' | 'compress';
  readonly index: number;
  readonly systemPrompt: string;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  readonly toolNames: ReadonlyArray<string>;
  readonly outputText: string;
}

export interface SessionEmitterProjectionReport {
  readonly ok: boolean;
  readonly mismatches: readonly string[];
  readonly recording: RecordedSessionOutput;
}

export interface MemoryEvaluationRun {
  readonly variantId: string;
  readonly memoryKind: string;
  readonly turnsRun: number;
  readonly stopReason: MemoryEvaluationStopReason;
  readonly stateVars: Record<string, unknown>;
  readonly currentScene: SceneState;
  readonly memorySnapshot: MemorySnapshot;
  readonly recording: RecordedSessionOutput;
  readonly persistence: MemoryEvaluationPersistenceSnapshot;
  readonly llmCalls: ReadonlyArray<ScriptedLLMCall>;
  readonly coreEvents: ReadonlyArray<CoreEvent>;
  readonly coreEventEnvelopes: ReadonlyArray<CoreEventEnvelope>;
  readonly coreEventProtocol: CoreEventProtocolReport;
  readonly sessionEmitterProjection: SessionEmitterProjectionReport;
}

export interface MemoryEvaluationComparison {
  readonly variantId: string;
  readonly status: RecordedSessionOutput['status'];
  readonly turnsRun: number;
  readonly generatedTexts: ReadonlyArray<string>;
  readonly inputRequestCount: number;
  readonly narrativeEntryCount: number;
  readonly memoryKind: string;
  readonly memorySummaryCount: number;
  readonly compressionCallCount: number;
  readonly finalScene: SceneState;
  readonly finalStateVars: Record<string, unknown>;
}

export interface MemoryEvaluationReport {
  readonly scenarioId: string;
  readonly runs: ReadonlyArray<MemoryEvaluationRun>;
  readonly comparisons: ReadonlyArray<MemoryEvaluationComparison>;
}

export async function runMemoryEvaluationSuite(
  options: MemoryEvaluationOptions,
): Promise<MemoryEvaluationReport> {
  const runs = [];
  for (const variant of options.variants) {
    runs.push(await runMemoryEvaluationCase({
      scenario: options.scenario,
      variant,
      script: options.script,
      compression: options.compression,
    }));
  }

  return {
    scenarioId: options.scenario.id,
    runs,
    comparisons: runs.map(createComparison),
  };
}

export async function runMemoryEvaluationCase(options: {
  readonly scenario: MemoryEvaluationScenario;
  readonly variant: MemoryEvaluationVariant;
  readonly script: ReadonlyArray<MemoryEvaluationScriptTurn>;
  readonly compression?: ScriptedCompressionFixture;
}): Promise<MemoryEvaluationRun> {
  const { scenario, variant, script } = options;
  const playthroughId = scenario.playthroughId ?? `memory-eval-${scenario.id}-${variant.id}`;
  const recording = createRecordingSessionOutputSink();
  const coreRecorder = createRecordingCoreEventSink({ playthroughId });
  const journal = createInMemoryEvaluationJournal(playthroughId);
  const harnessCoreEventSink = createHarnessCoreEventSink(
    recording,
    coreRecorder,
    journal.persistence,
  );
  const llmClient = createScriptedEvaluationLLM({
    turns: script.map((turn) => turn.generate),
    compression: options.compression,
  });
  const stateStore = new StateStore(scenario.stateSchema);
  const memory = await createVariantMemory({
    scenario,
    variant,
    playthroughId,
    reader: journal.reader,
    llmClient,
  });

  let currentScene = copyScene(scenario.defaultScene ?? { background: null, sprites: [] });
  let lastPlayerInput = '';
  let scenarioEnded = false;
  let scenarioEndReason: string | undefined;
  let stopReason: MemoryEvaluationStopReason = 'completed-script';
  let turnsRun = 0;

  harnessCoreEventSink.publish({
    type: 'session-started',
    snapshot: await createHarnessSnapshot(memory, stateStore, currentScene),
  });

  for (const turnSpec of script) {
    const turn = stateStore.getTurn() + 1;
    stateStore.setTurn(turn);
    turnsRun += 1;

    const runtime = createGenerateTurnRuntime({
      turn,
      stateStore,
      memory,
      llmClient,
      segments: scenario.segments,
      enabledTools: scenario.enabledTools ?? [],
      tokenBudget: scenario.tokenBudget ?? 120000,
      initialPrompt: scenario.initialPrompt,
      assemblyOrder: scenario.assemblyOrder,
      disabledSections: scenario.disabledSections,
      coreEventSink: harnessCoreEventSink,
      ...createRuntimeProtocolConfig(scenario),
      characters: scenario.characters ?? [],
      backgrounds: scenario.backgrounds ?? [],
      currentScene,
      buildRetrievalQuery: async () =>
        buildRetrievalQuery(stateStore.getAll(), lastPlayerInput),
      isActive: () => true,
      onScenarioEnd: (reason) => {
        scenarioEnded = true;
        scenarioEndReason = reason;
      },
    });

    const result = await runtime.run();
    currentScene = result.currentScene;
    if (result.stopped) {
      stopReason = 'stopped';
      break;
    }

    if (scenarioEnded) {
      await publishHarnessCoreEvent(harnessCoreEventSink, {
        type: 'session-finished',
        reason: scenarioEndReason,
        snapshot: await createHarnessSnapshot(memory, stateStore, currentScene),
      });
      stopReason = 'scenario-finished';
      break;
    }

    const inputText = getScriptedInput(turnSpec.input);
    await requestInput({
      memory,
      coreEventSink: harnessCoreEventSink,
      stateStore,
      currentScene,
      pendingSignal: result.pendingSignal,
    });

    if (inputText === null) {
      stopReason = 'waiting-for-unscripted-input';
      break;
    }

    lastPlayerInput = inputText;
    await receiveInput({
      memory,
      coreEventSink: harnessCoreEventSink,
      stateStore,
      currentScene,
      pendingSignal: result.pendingSignal,
      inputText,
    });
  }

  const memorySnapshot = await memory.snapshot();
  const coreEvents = coreRecorder.getEvents();
  const recordingSnapshot = recording.getSnapshot();
  return {
    variantId: variant.id,
    memoryKind: memory.kind,
    turnsRun,
    stopReason,
    stateVars: stateStore.getAll(),
    currentScene,
    memorySnapshot,
    recording: recordingSnapshot,
    persistence: journal.getSnapshot(),
    llmCalls: llmClient.getCalls(),
    coreEvents,
    coreEventEnvelopes: coreRecorder.getEnvelopes(),
    coreEventProtocol: validateCoreEventSequence(coreEvents),
    sessionEmitterProjection: validateSessionEmitterProjection(recordingSnapshot, coreEvents),
  };
}

export async function runLiveMemoryEvaluationSuite(
  options: LiveMemoryEvaluationOptions,
): Promise<MemoryEvaluationReport> {
  const runs = [];
  for (const variant of options.variants) {
    runs.push(await runLiveMemoryEvaluationCase({
      scenario: options.scenario,
      variant,
      llmConfig: createNoThinkingLLMConfig(options.llmConfig),
      inputs: options.inputs,
      maxTurns: options.maxTurns,
    }));
  }

  return {
    scenarioId: options.scenario.id,
    runs,
    comparisons: runs.map(createComparison),
  };
}

export async function runLiveMemoryEvaluationCase(options: {
  readonly scenario: MemoryEvaluationScenario;
  readonly variant: MemoryEvaluationVariant;
  readonly llmConfig: LLMConfig;
  readonly inputs: ReadonlyArray<ScriptedInput>;
  readonly maxTurns?: number;
}): Promise<MemoryEvaluationRun> {
  const { scenario, variant } = options;
  const playthroughId = scenario.playthroughId ?? `memory-live-${scenario.id}-${variant.id}`;
  const recording = createRecordingSessionOutputSink();
  const coreRecorder = createRecordingCoreEventSink({ playthroughId });
  const journal = createInMemoryEvaluationJournal(playthroughId);
  const harnessCoreEventSink = createHarnessCoreEventSink(
    recording,
    coreRecorder,
    journal.persistence,
  );
  const llmClient = createRecordingEvaluationLLM(new LLMClient(createNoThinkingLLMConfig(options.llmConfig)));
  const stateStore = new StateStore(scenario.stateSchema);
  const memory = await createVariantMemory({
    scenario,
    variant,
    playthroughId,
    reader: journal.reader,
    llmClient,
  });

  let currentScene = copyScene(scenario.defaultScene ?? { background: null, sprites: [] });
  let lastPlayerInput = '';
  let scenarioEnded = false;
  let scenarioEndReason: string | undefined;
  let stopReason: MemoryEvaluationStopReason = 'completed-script';
  let turnsRun = 0;
  const maxTurns = options.maxTurns ?? Math.max(1, options.inputs.length + 1);

  harnessCoreEventSink.publish({
    type: 'session-started',
    snapshot: await createHarnessSnapshot(memory, stateStore, currentScene),
  });

  for (let turnIndex = 0; turnIndex < maxTurns; turnIndex += 1) {
    const turn = stateStore.getTurn() + 1;
    stateStore.setTurn(turn);
    turnsRun += 1;

    const runtime = createGenerateTurnRuntime({
      turn,
      stateStore,
      memory,
      llmClient,
      segments: scenario.segments,
      enabledTools: scenario.enabledTools ?? [],
      tokenBudget: scenario.tokenBudget ?? 120000,
      initialPrompt: scenario.initialPrompt,
      assemblyOrder: scenario.assemblyOrder,
      disabledSections: scenario.disabledSections,
      coreEventSink: harnessCoreEventSink,
      ...createRuntimeProtocolConfig(scenario),
      characters: scenario.characters ?? [],
      backgrounds: scenario.backgrounds ?? [],
      currentScene,
      buildRetrievalQuery: async () =>
        buildRetrievalQuery(stateStore.getAll(), lastPlayerInput),
      isActive: () => true,
      onScenarioEnd: (reason) => {
        scenarioEnded = true;
        scenarioEndReason = reason;
      },
    });

    const result = await runtime.run();
    currentScene = result.currentScene;
    if (result.stopped) {
      stopReason = 'stopped';
      break;
    }

    if (scenarioEnded) {
      await publishHarnessCoreEvent(harnessCoreEventSink, {
        type: 'session-finished',
        reason: scenarioEndReason,
        snapshot: await createHarnessSnapshot(memory, stateStore, currentScene),
      });
      stopReason = 'scenario-finished';
      break;
    }

    await requestInput({
      memory,
      coreEventSink: harnessCoreEventSink,
      stateStore,
      currentScene,
      pendingSignal: result.pendingSignal,
    });

    const inputText = getScriptedInput(options.inputs[turnIndex]);
    if (inputText === null) {
      stopReason = 'waiting-for-unscripted-input';
      break;
    }

    lastPlayerInput = inputText;
    await receiveInput({
      memory,
      coreEventSink: harnessCoreEventSink,
      stateStore,
      currentScene,
      pendingSignal: result.pendingSignal,
      inputText,
    });
  }

  const memorySnapshot = await memory.snapshot();
  const coreEvents = coreRecorder.getEvents();
  const recordingSnapshot = recording.getSnapshot();
  return {
    variantId: variant.id,
    memoryKind: memory.kind,
    turnsRun,
    stopReason,
    stateVars: stateStore.getAll(),
    currentScene,
    memorySnapshot,
    recording: recordingSnapshot,
    persistence: journal.getSnapshot(),
    llmCalls: llmClient.getCalls(),
    coreEvents,
    coreEventEnvelopes: coreRecorder.getEnvelopes(),
    coreEventProtocol: validateCoreEventSequence(coreEvents),
    sessionEmitterProjection: validateSessionEmitterProjection(recordingSnapshot, coreEvents),
  };
}

export function createNoThinkingLLMConfig(config: LLMConfig): LLMConfig {
  return {
    ...config,
    thinkingEnabled: false,
    reasoningEffort: null,
  };
}

function validateSessionEmitterProjection(
  expected: RecordedSessionOutput,
  coreEvents: ReadonlyArray<CoreEvent>,
): SessionEmitterProjectionReport {
  const projectedRecorder = createRecordingSessionEmitter();
  const projection = createLegacySessionEmitterProjection(projectedRecorder.emitter);
  for (const event of coreEvents) {
    projection.publish(event);
  }

  const projected = projectedRecorder.getSnapshot();
  return {
    ok: normalizedSessionOutputKey(expected) === normalizedSessionOutputKey(projected),
    mismatches: findSessionOutputMismatches(expected, projected),
    recording: projected,
  };
}

function findSessionOutputMismatches(
  expected: RecordedSessionOutput,
  actual: RecordedSessionOutput,
): string[] {
  const expectedNormalized = normalizeSessionOutput(expected);
  const actualNormalized = normalizeSessionOutput(actual);
  return Object.keys(expectedNormalized)
    .filter((key) => {
      const field = key as keyof ReturnType<typeof normalizeSessionOutput>;
      return JSON.stringify(expectedNormalized[field]) !== JSON.stringify(actualNormalized[field]);
    });
}

function normalizedSessionOutputKey(output: RecordedSessionOutput): string {
  return JSON.stringify(normalizeSessionOutput(output));
}

function normalizeSessionOutput(output: RecordedSessionOutput): RecordedSessionOutput {
  return {
    ...output,
    toolCalls: output.toolCalls.map(stripToolTimestamp),
    pendingToolCalls: output.pendingToolCalls.map(stripToolTimestamp),
  };
}

function stripToolTimestamp(entry: ToolCallEntry): ToolCallEntry {
  return { ...entry, timestamp: 0 };
}

function createHarnessCoreEventSink(
  recording: CoreEventSink,
  downstream: CoreEventSink,
  persistence: SessionPersistence,
): CoreEventBus {
  const realtimeSink: CoreEventSink = {
    publish(event) {
      recording.publish(event);
      downstream.publish(event);
    },
    async flushDurable() {
      await Promise.all([
        recording.flushDurable?.(),
        downstream.flushDurable?.(),
      ]);
    },
  };

  return createDurableFirstCoreEventSink({
    durableSinks: [createSessionPersistenceCoreEventSink(persistence)],
    realtimeSinks: [realtimeSink],
    isDurableEvent: isSessionPersistenceCoreEvent,
  });
}

async function publishHarnessCoreEvent(
  sink: CoreEventSink,
  event: CoreEvent,
): Promise<void> {
  sink.publish(event);
  await sink.flushDurable?.();
}

function createVariantMemory(options: {
  readonly scenario: MemoryEvaluationScenario;
  readonly variant: MemoryEvaluationVariant;
  readonly playthroughId: string;
  readonly reader: NarrativeHistoryReader;
  readonly llmClient: Pick<LLMClient, 'generate'>;
}): Promise<Memory> {
  const { scenario, variant } = options;
  const factory = variant.memoryFactory ?? createMemory;
  return factory({
    scope: {
      playthroughId: options.playthroughId,
      userId: scenario.userId ?? 'memory-eval-user',
      chapterId: scenario.chapterId ?? 'memory-eval-chapter',
    },
    config: variant.memoryConfig,
    llmClient: options.llmClient,
    mem0ApiKey: variant.mem0ApiKey,
    reader: options.reader,
  });
}

function createRuntimeProtocolConfig(scenario: MemoryEvaluationScenario): {
  readonly protocolVersion: ProtocolVersion;
  readonly parserManifest: ParserManifest;
} {
  const protocolVersion = resolveRuntimeProtocolVersion(scenario.protocolVersion);
  return {
    protocolVersion,
    parserManifest: scenario.parserManifest ?? buildParserManifest({
      characters: scenario.characters,
      backgrounds: scenario.backgrounds,
    }),
  };
}

function buildRetrievalQuery(
  stateVars: Record<string, unknown>,
  lastPlayerInput: string,
): string {
  const focus = computeFocus(stateVars);
  return [focus.scene, lastPlayerInput].filter((part): part is string => !!part).join('. ');
}

async function requestInput(options: {
  readonly memory: Memory;
  readonly coreEventSink: CoreEventSink;
  readonly stateStore: StateStore;
  readonly currentScene: SceneState;
  readonly pendingSignal: {
    readonly hint: string;
    readonly choices: ReadonlyArray<string>;
    readonly batchId?: string | null;
  } | null;
}): Promise<void> {
  const signal = options.pendingSignal;
  const choices = signal?.choices && signal.choices.length > 0 ? [...signal.choices] : null;
  const hint = signal?.hint ?? null;
  const turn = options.stateStore.getTurn();

  await publishHarnessCoreEvent(options.coreEventSink, {
    type: 'waiting-input-started',
    turnId: toTurnId(turn),
    requestId: toInputRequestId(turn),
    source: signal ? 'signal' : 'fallback',
    causedByBatchId: toBatchId(signal?.batchId),
    request: createInputRequest(hint, choices),
    snapshot: await createHarnessSnapshot(options.memory, options.stateStore, options.currentScene),
  });
}

async function receiveInput(options: {
  readonly memory: Memory;
  readonly coreEventSink: CoreEventSink;
  readonly stateStore: StateStore;
  readonly currentScene: SceneState;
  readonly pendingSignal: {
    readonly choices: ReadonlyArray<string>;
    readonly batchId?: string | null;
  } | null;
  readonly inputText: string;
}): Promise<void> {
  const payload = options.pendingSignal
    ? computeReceivePayload(options.inputText, [...options.pendingSignal.choices])
    : { inputType: 'freetext' as const };
  const turn = options.stateStore.getTurn();

  const sentence = {
    kind: 'player_input',
    text: options.inputText,
    ...(payload.selectedIndex !== undefined ? { selectedIndex: payload.selectedIndex } : {}),
    sceneRef: copyScene(options.currentScene),
    turnNumber: turn,
    index: turn * 1000,
  } as const;

  await options.memory.appendTurn({
    turn,
    role: 'receive',
    content: options.inputText,
    tokenCount: estimateTokens(options.inputText),
  });

  const receiveBatchId = `memory-eval-receive-${turn}` as BatchId;
  const memorySnapshot = await options.memory.snapshot();
  await publishHarnessCoreEvent(options.coreEventSink, {
    type: 'player-input-recorded',
    turnId: toTurnId(turn),
    requestId: toInputRequestId(turn),
    batchId: receiveBatchId,
    text: options.inputText,
    payload,
    sentence,
    snapshot: {
      turn,
      stateVars: options.stateStore.getAll(),
      memorySnapshot,
      currentScene: copyScene(options.currentScene),
    },
  });
}

async function createHarnessSnapshot(
  memory: Memory,
  stateStore: StateStore,
  currentScene: SceneState,
): Promise<{
  readonly turn: number;
  readonly stateVars: Record<string, unknown>;
  readonly memorySnapshot: Record<string, unknown>;
  readonly currentScene: SceneState;
}> {
  return {
    turn: stateStore.getTurn(),
    stateVars: stateStore.getAll(),
    memorySnapshot: await memory.snapshot(),
    currentScene: copyScene(currentScene),
  };
}

interface ScriptedEvaluationLLM extends Pick<LLMClient, 'generate'> {
  getCalls(): ReadonlyArray<ScriptedLLMCall>;
}

function createRecordingEvaluationLLM(
  client: Pick<LLMClient, 'generate'>,
): ScriptedEvaluationLLM {
  let index = 0;
  const calls: ScriptedLLMCall[] = [];

  return {
    async generate(options) {
      const result = await client.generate(options);
      index += 1;
      calls.push(createLLMCall(
        Object.keys(options.tools).length === 0 ? 'compress' : 'generate',
        index,
        options,
        result.text,
      ));
      return result;
    },

    getCalls() {
      return calls.map(copyLLMCall);
    },
  };
}

function createScriptedEvaluationLLM(options: {
  readonly turns: ReadonlyArray<ScriptedGenerateTurn>;
  readonly compression?: ScriptedCompressionFixture;
}): ScriptedEvaluationLLM {
  let turnIndex = 0;
  let compressionIndex = 0;
  const calls: ScriptedLLMCall[] = [];

  return {
    async generate(generateOptions) {
      const isCompression = Object.keys(generateOptions.tools).length === 0;
      if (isCompression) {
        const response = selectCompressionResponse(
          options.compression,
          compressionIndex,
          generateOptions,
        );
        compressionIndex += 1;
        calls.push(createLLMCall('compress', compressionIndex, generateOptions, response));
        emitSyntheticStep(generateOptions, {
          index: compressionIndex,
          text: response,
          finishReason: 'stop',
          toolCalls: [],
        });
        return {
          text: response,
          toolCalls: [],
          finishReason: 'stop',
        };
      }

      const turn = options.turns[turnIndex];
      if (!turn) {
        throw new Error(`No scripted LLM turn for generate call ${turnIndex + 1}`);
      }
      turnIndex += 1;
      const result = await runScriptedGenerateTurn(generateOptions, turn, turnIndex);
      calls.push(createLLMCall('generate', turnIndex, generateOptions, result.text));
      return result;
    },

    getCalls() {
      return calls.map(copyLLMCall);
    },
  };
}

async function runScriptedGenerateTurn(
  options: GenerateOptions,
  turn: ScriptedGenerateTurn,
  turnIndex: number,
): Promise<GenerateResult> {
  const textChunks = normalizeChunks(turn.text);
  const reasoningChunks = normalizeChunks(turn.reasoning);
  const toolCalls = turn.toolCalls ?? [];
  const finishReason = turn.finishReason ?? 'stop';
  const stepNumber = 0;
  const batchId = `memory-eval-generate-${turnIndex}-step-1`;

  options.onStepStart?.({ stepNumber, batchId, isFollowup: false });

  for (const chunk of reasoningChunks) {
    options.onReasoningChunk?.(chunk);
  }
  for (const chunk of textChunks) {
    options.onTextChunk?.(chunk);
  }

  const toolResults = [];
  for (const toolCall of toolCalls) {
    const output = await runScriptedToolCall(options, toolCall, batchId);
    toolResults.push({
      name: toolCall.name,
      args: toolCall.args,
      result: output,
    });
  }

  const text = textChunks.join('');
  emitSyntheticStep(options, {
    index: turnIndex,
    text,
    reasoning: reasoningChunks.join('') || undefined,
    finishReason,
    toolCalls,
    model: turn.model,
    batchId,
  });

  return { text, toolCalls: toolResults, finishReason };
}

async function runScriptedToolCall(
  options: GenerateOptions,
  toolCall: ScriptedToolCall,
  batchId: string,
): Promise<unknown> {
  options.onToolCall?.(toolCall.name, toolCall.args);
  const handler = options.tools[toolCall.name];
  const output = handler
    ? await handler.execute(toolCall.args)
    : { success: false, error: `Tool "${toolCall.name}" is not available` };
  options.onToolResult?.(toolCall.name, output);

  if (
    options.onToolObserved &&
    toolCall.name !== 'signal_input_needed' &&
    toolCall.name !== 'end_scenario'
  ) {
    await options.onToolObserved({
      batchId,
      toolName: toolCall.name,
      input: toolCall.args,
      output,
      success: isSuccessfulToolOutput(output),
    });
  }

  return output;
}

function emitSyntheticStep(
  options: GenerateOptions,
  step: {
    readonly index: number;
    readonly text: string;
    readonly reasoning?: string;
    readonly finishReason: string;
    readonly toolCalls: ReadonlyArray<ScriptedToolCall>;
    readonly model?: string;
    readonly batchId?: string;
  },
): void {
  options.onStep?.({
    stepNumber: 0,
    text: step.text,
    reasoning: step.reasoning,
    finishReason: step.finishReason,
    toolCalls: step.toolCalls.map((toolCall) => ({
      name: toolCall.name,
      args: toolCall.args,
    })),
    model: step.model,
    partKinds: [
      ...(step.text ? ['text'] : []),
      ...(step.toolCalls.length > 0 ? ['tool-call'] : []),
    ],
    batchId: step.batchId ?? `memory-eval-compress-${step.index}-step-1`,
    isFollowup: false,
  } satisfies StepInfo);
}

function selectCompressionResponse(
  compression: ScriptedCompressionFixture | undefined,
  index: number,
  options: GenerateOptions,
): string {
  const scripted = compression?.responses?.[index];
  if (scripted !== undefined) return scripted;
  if (compression?.defaultResponse !== undefined) return compression.defaultResponse;

  const transcript = options.messages
    .map((message) => serializeMessage(message).content)
    .join('\n');
  return transcript.slice(0, 500).trim() || 'No memory summary.';
}

function createLLMCall(
  kind: ScriptedLLMCall['kind'],
  index: number,
  options: GenerateOptions,
  outputText: string,
): ScriptedLLMCall {
  return {
    kind,
    index,
    systemPrompt: options.systemPrompt,
    messages: options.messages.map(serializeMessage),
    toolNames: Object.keys(options.tools),
    outputText,
  };
}

class InMemoryEvaluationJournal {
  private readonly entries: NarrativeEntry[] = [];
  private readonly generateStarts: number[] = [];
  private readonly generateCompletes: GenerateCompleteRecord[] = [];
  private readonly waitingInputs: WaitingInputRecord[] = [];
  private readonly receiveCompletes: ReceiveCompleteRecord[] = [];
  private readonly scenarioFinished: ScenarioFinishedRecord[] = [];

  readonly persistence: SessionPersistence = {
    onGenerateStart: async (turn) => {
      this.generateStarts.push(turn);
    },

    onNarrativeSegmentFinalized: async (data) => {
      this.appendEntry({
        role: data.entry.role,
        kind: 'narrative',
        content: data.entry.content,
        reasoning: data.entry.reasoning ?? null,
        finishReason: data.entry.finishReason ?? null,
        batchId: data.batchId ?? null,
      });
    },

    onGenerateComplete: async (data) => {
      this.generateCompletes.push(cloneValue(data));
    },

    onWaitingInput: async (data) => {
      this.waitingInputs.push(cloneValue(data));
    },

    onSignalInputRecorded: async (data) => {
      this.appendEntry({
        role: 'generate',
        kind: 'signal_input',
        content: data.hint,
        payload: { choices: [...data.choices] },
        batchId: data.batchId ?? null,
      });
    },

    onToolCallRecorded: async (data) => {
      this.appendEntry({
        role: 'generate',
        kind: 'tool_call',
        content: data.toolName,
        payload: {
          input: cloneValue(data.input),
          output: cloneValue(data.output),
        },
        batchId: data.batchId,
      });
    },

    onReceiveComplete: async (data) => {
      this.receiveCompletes.push(cloneValue(data));
      this.appendEntry({
        role: data.entry.role,
        kind: 'player_input',
        content: data.entry.content,
        payload: cloneValue(data.payload ?? { inputType: 'freetext' }),
        batchId: data.batchId ?? null,
      });
    },

    onScenarioFinished: async (data) => {
      this.scenarioFinished.push(cloneValue(data));
    },
  };

  readonly reader: NarrativeHistoryReader = {
    readRecent: async (opts) =>
      this.entries
        .filter((entry) => matchesKind(entry, opts.kinds))
        .slice(-opts.limit)
        .map(copyNarrativeEntry),

    readRange: async (opts) =>
      this.entries
        .filter((entry) =>
          (opts.fromOrderIdx === undefined || entry.orderIdx >= opts.fromOrderIdx) &&
          (opts.toOrderIdx === undefined || entry.orderIdx <= opts.toOrderIdx))
        .map(copyNarrativeEntry),
  };

  constructor(private readonly playthroughId: string) {}

  getSnapshot(): MemoryEvaluationPersistenceSnapshot {
    return {
      entries: this.entries.map(copyNarrativeEntry),
      generateStarts: [...this.generateStarts],
      generateCompletes: this.generateCompletes.map(cloneValue),
      waitingInputs: this.waitingInputs.map(cloneValue),
      receiveCompletes: this.receiveCompletes.map(cloneValue),
      scenarioFinished: this.scenarioFinished.map(cloneValue),
    };
  }

  private appendEntry(data: {
    readonly role: string;
    readonly kind: EntryKind;
    readonly content: string;
    readonly payload?: Record<string, unknown> | null;
    readonly reasoning?: string | null;
    readonly finishReason?: string | null;
    readonly batchId?: string | null;
  }): void {
    const orderIdx = this.entries.length;
    this.entries.push({
      id: `${this.playthroughId}-entry-${orderIdx + 1}`,
      playthroughId: this.playthroughId,
      role: data.role,
      kind: data.kind,
      content: data.content,
      payload: data.payload ? cloneValue(data.payload) : null,
      reasoning: data.reasoning ?? null,
      finishReason: data.finishReason ?? null,
      batchId: data.batchId ?? null,
      orderIdx,
      createdAt: new Date(orderIdx),
    });
  }
}

function createInMemoryEvaluationJournal(playthroughId: string): InMemoryEvaluationJournal {
  return new InMemoryEvaluationJournal(playthroughId);
}

function createComparison(run: MemoryEvaluationRun): MemoryEvaluationComparison {
  return {
    variantId: run.variantId,
    status: run.recording.status,
    turnsRun: run.turnsRun,
    generatedTexts: run.recording.streamingEntries.map((entry) => entry.text),
    inputRequestCount: run.recording.inputRequests.length,
    narrativeEntryCount: run.persistence.entries.length,
    memoryKind: run.memoryKind,
    memorySummaryCount: countSnapshotSummaries(run.memorySnapshot),
    compressionCallCount: run.llmCalls.filter((call) => call.kind === 'compress').length,
    finalScene: copyScene(run.currentScene),
    finalStateVars: cloneValue(run.stateVars),
  };
}

function getScriptedInput(input: ScriptedInput | undefined): string | null {
  if (input === undefined) return null;
  return typeof input === 'string' ? input : input.text;
}

function normalizeChunks(chunks: string | ReadonlyArray<string> | undefined): string[] {
  if (chunks === undefined) return [];
  return typeof chunks === 'string' ? [chunks] : [...chunks];
}

function matchesKind(entry: NarrativeEntry, kinds: ReadonlyArray<EntryKind> | undefined): boolean {
  return kinds === undefined || kinds.includes(entry.kind);
}

function countSnapshotSummaries(snapshot: MemorySnapshot): number {
  return Array.isArray(snapshot.summaries) ? snapshot.summaries.length : 0;
}

function serializeMessage(message: GenerateOptions['messages'][number]): {
  readonly role: string;
  readonly content: string;
} {
  const content = message.content;
  return {
    role: String(message.role),
    content: typeof content === 'string' ? content : JSON.stringify(content),
  };
}

function isSuccessfulToolOutput(output: unknown): boolean {
  return !(
    output &&
    typeof output === 'object' &&
    'success' in output &&
    (output as { readonly success?: unknown }).success === false
  );
}

function copyLLMCall(call: ScriptedLLMCall): ScriptedLLMCall {
  return {
    kind: call.kind,
    index: call.index,
    systemPrompt: call.systemPrompt,
    messages: call.messages.map((message) => ({ ...message })),
    toolNames: [...call.toolNames],
    outputText: call.outputText,
  };
}

function copyNarrativeEntry(entry: NarrativeEntry): NarrativeEntry {
  return {
    ...entry,
    payload: entry.payload ? cloneValue(entry.payload) : null,
    createdAt: new Date(entry.createdAt.getTime()),
  };
}

function copyScene(scene: SceneState): SceneState {
  return {
    background: scene.background,
    sprites: scene.sprites.map((sprite) => ({ ...sprite })),
  };
}

function cloneValue<T>(value: T): T {
  try {
    return structuredClone(value) as T;
  } catch {
    return value;
  }
}
