/**
 * GenerateTurnRuntime
 *
 * Owns the lifecycle and turn-scoped state for one GameSession generate phase.
 * It does not wait for player input; it only records the pending signal that
 * the outer session receive phase will consume.
 */

import type {
  BackgroundAsset,
  CharacterAsset,
  ParticipationFrame,
  PromptSegment,
  ProtocolVersion,
  SceneState,
  ScratchBlock,
  Sentence,
} from '#internal/types';
import type { StateStore } from '#internal/state-store';
import type { Memory } from '#internal/memory/types';
import { estimateTokens } from '#internal/tokens';
import { assembleContext } from '#internal/context-assembler';
import { computeFocus } from '#internal/focus';
import { createTools, getEnabledTools } from '#internal/tool-executor';
import type { ScenePatch, SignalInputOptions } from '#internal/tool-executor';
import type { GenerateOptions, GenerateResult, LLMClient, StepInfo } from '#internal/llm-client';
import type { SessionEmitter } from '#internal/session-emitter';
import { NarrativeParser, extractPlainText } from '#internal/narrative-parser';
import {
  createParser as createParserV2,
  type DegradeEvent as DegradeEventV2,
  type NarrativeParser as NarrativeParserV2,
  type ParserManifest,
} from '#internal/narrative-parser-v2';
import { serializeMessagesForDebug } from '#internal/messages-builder';
import { createNarrationAccumulator } from '#internal/game-session/narration';
import { applyScenePatchToState } from '#internal/game-session/scene-state';
import type {
  GenerateTraceHandle,
  SessionPersistence,
  SessionTracing,
  ToolCallTraceHandle,
} from '#internal/game-session/types';

type SceneTransition = 'fade' | 'cut' | 'dissolve';
type PrepareStepSystem = NonNullable<GenerateOptions['prepareStepSystem']>;

type StepStartInfo = {
  batchId: string;
  isFollowup: boolean;
};

type TraceStepRecord = Parameters<GenerateTraceHandle['recordStep']>[0];

type GeneratedSentenceDraft =
  | { kind: 'narration'; text: string }
  | { kind: 'dialogue'; text: string; pf: ParticipationFrame; truncated?: boolean }
  | { kind: 'scene_change'; scene: SceneState; transition?: SceneTransition };

type NarrativeBatch = {
  readonly sentences: ReadonlyArray<Sentence>;
  readonly scratches: ReadonlyArray<ScratchBlock>;
  readonly degrades: ReadonlyArray<DegradeEventV2>;
};

interface NarrativeRuntime {
  feedTextChunk(chunk: string): void;
  finalizeParser(): void;
  flushPendingNarration(): void;
}

interface GenerateTurnPrepared {
  readonly context: Awaited<ReturnType<typeof assembleContext>>;
  readonly tools: ReturnType<typeof getEnabledTools>;
  readonly prepareStepSystem: PrepareStepSystem;
}

interface ActiveGenerateTurn extends GenerateTurnPrepared {
  readonly narrativeRuntime: NarrativeRuntime;
}

export interface GenerateTurnPendingSignal {
  readonly hint: string;
  readonly choices: string[];
  /** 发起 signal 的 LLM step 的 batchId，用于 signal_input / narrative / player_input 分组 */
  readonly batchId: string | null;
}

export interface GenerateTurnResult {
  readonly currentScene: SceneState;
  readonly pendingSignal: GenerateTurnPendingSignal | null;
  readonly stopped: boolean;
}

export interface GenerateTurnRuntime {
  run(): Promise<GenerateTurnResult>;
  abort(): void;
}

export interface GenerateTurnRuntimeDeps {
  readonly turn: number;
  readonly emitter: SessionEmitter;
  readonly stateStore: StateStore;
  readonly memory: Memory;
  readonly llmClient: Pick<LLMClient, 'generate'>;
  readonly segments: ReadonlyArray<PromptSegment>;
  readonly enabledTools: ReadonlyArray<string>;
  readonly tokenBudget: number;
  readonly initialPrompt?: string;
  readonly assemblyOrder?: ReadonlyArray<string>;
  readonly disabledSections?: ReadonlyArray<string>;
  readonly persistence?: SessionPersistence;
  readonly tracing?: SessionTracing;
  readonly protocolVersion: ProtocolVersion;
  readonly parserManifest?: ParserManifest;
  readonly characters: ReadonlyArray<CharacterAsset>;
  readonly backgrounds: ReadonlyArray<BackgroundAsset>;
  readonly currentScene: SceneState;
  buildRetrievalQuery(): Promise<string>;
  isActive(): boolean;
  onScenarioEnd(reason?: string): void;
}

const TRACE_STEP_FIELDS = [
  'stepNumber',
  'text',
  'reasoning',
  'finishReason',
  'inputTokens',
  'outputTokens',
  'model',
  'partKinds',
  'responseTimestamp',
  'stepStartAt',
  'stepInputMessages',
  'effectiveSystemPrompt',
  'isFollowup',
] as const satisfies ReadonlyArray<keyof StepInfo & keyof TraceStepRecord>;

export function createGenerateTurnRuntime(deps: GenerateTurnRuntimeDeps): GenerateTurnRuntime {
  return new DefaultGenerateTurnRuntime(deps);
}

function toTraceStepRecord(step: StepInfo): TraceStepRecord {
  return Object.fromEntries(
    TRACE_STEP_FIELDS.map((field) => [field, step[field]]),
  ) as TraceStepRecord;
}

class DefaultGenerateTurnRuntime implements GenerateTurnRuntime {
  private currentScene: SceneState;
  private currentNarrativeBuffer = '';
  private currentReasoningBuffer = '';
  private currentStepBatchId: string | null = null;
  private pendingSignal: GenerateTurnPendingSignal | null = null;
  private scenePatchEmitter:
    | ((transition?: SceneTransition) => void)
    | null = null;
  private pendingNarrationFlusher: (() => void) | null = null;
  private abortController: AbortController | null = null;

  constructor(private readonly deps: GenerateTurnRuntimeDeps) {
    this.currentScene = copyScene(deps.currentScene);
  }

  async run(): Promise<GenerateTurnResult> {
    const traceHandle = this.deps.tracing?.startGenerateTrace(this.deps.turn);
    const toolCallStack = new Map<string, ToolCallTraceHandle[]>();

    try {
      const prepared = await this.prepareGenerateTurn(traceHandle);
      if (!this.deps.isActive()) {
        traceHandle?.end({ stopped: true });
        return this.snapshotResult(true);
      }
      const activeTurn = this.beginGenerateTurn(prepared, traceHandle);
      const result = await this.runLLMGenerate(activeTurn, traceHandle, toolCallStack);
      await this.completeGenerateTurn(activeTurn, result, traceHandle);
    } catch (error) {
      if (!this.deps.isActive()) {
        return this.snapshotResult(true);
      }
      this.failGenerateTurn(error, traceHandle);
    } finally {
      this.currentStepBatchId = null;
      this.scenePatchEmitter = null;
      this.pendingNarrationFlusher = null;
      this.abortController = null;
    }

    return this.snapshotResult(false);
  }

  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  private async prepareGenerateTurn(
    traceHandle: GenerateTraceHandle | undefined,
  ): Promise<GenerateTurnPrepared> {
    this.currentStepBatchId = null;

    const allTools = this.createTurnTools();
    const tools = getEnabledTools(allTools, [...this.deps.enabledTools]);
    const runAssemble = async (focus: ReturnType<typeof computeFocus>) =>
      assembleContext({
        segments: [...this.deps.segments],
        stateStore: this.deps.stateStore,
        memory: this.deps.memory,
        tokenBudget: this.deps.tokenBudget,
        initialPrompt: this.deps.initialPrompt,
        currentQuery: await this.deps.buildRetrievalQuery(),
        focus,
        assemblyOrder: this.deps.assemblyOrder ? [...this.deps.assemblyOrder] : undefined,
        disabledSections: this.deps.disabledSections ? [...this.deps.disabledSections] : undefined,
        protocolVersion: this.deps.protocolVersion,
        characters: this.deps.characters,
        backgrounds: this.deps.backgrounds,
      });

    const focus = computeFocus(this.deps.stateStore.getAll());
    const context = await runAssemble(focus);
    const activeSegmentIds = this.computeActiveSegmentIds();
    const debugMessages = serializeMessagesForDebug(context.messages);

    this.deps.emitter.updateDebug({
      tokenBreakdown: context.tokenBreakdown,
      assembledSystemPrompt: context.systemPrompt,
      assembledMessages: debugMessages,
      activeSegmentIds,
    });

    this.deps.emitter.stagePendingDebug({
      promptSnapshot: {
        systemPrompt: context.systemPrompt,
        messages: debugMessages,
        tokenBreakdown: context.tokenBreakdown,
        activeSegmentIds,
      },
    });

    traceHandle?.setInput({
      systemPrompt: context.systemPrompt,
      messages: debugMessages,
    });

    return {
      context,
      tools,
      prepareStepSystem: this.createPrepareStepSystem(context, runAssemble, traceHandle),
    };
  }

  private beginGenerateTurn(
    prepared: GenerateTurnPrepared,
    traceHandle: GenerateTraceHandle | undefined,
  ): ActiveGenerateTurn {
    this.abortController = new AbortController();
    this.currentNarrativeBuffer = '';
    this.currentReasoningBuffer = '';
    this.deps.emitter.beginStreamingEntry();

    const narrativeRuntime = this.createNarrativeRuntime(traceHandle);
    this.pendingNarrationFlusher = narrativeRuntime.flushPendingNarration;

    return { ...prepared, narrativeRuntime };
  }

  private async runLLMGenerate(
    prepared: ActiveGenerateTurn,
    traceHandle: GenerateTraceHandle | undefined,
    toolCallStack: Map<string, ToolCallTraceHandle[]>,
  ): Promise<GenerateResult> {
    return this.deps.llmClient.generate({
      systemPrompt: prepared.context.systemPrompt,
      messages: prepared.context.messages,
      tools: prepared.tools,
      maxSteps: 30,
      // maxOutputTokens 默认从 LLMClient 的 config.maxOutputTokens 取（P2a 修复）
      abortSignal: this.abortController?.signal,
      prepareStepSystem: prepared.prepareStepSystem,
      onTextChunk: (chunk) => {
        this.currentNarrativeBuffer += chunk;
        this.deps.emitter.appendToStreamingEntry(chunk);
        prepared.narrativeRuntime.feedTextChunk(chunk);
      },
      onReasoningChunk: (chunk) => {
        this.currentReasoningBuffer += chunk;
        this.deps.emitter.appendReasoningToStreamingEntry(chunk);
      },
      onToolCall: (name, args) => {
        this.deps.emitter.addToolCall({ name, args, result: undefined });
        this.deps.emitter.addPendingToolCall({ name, args, result: undefined });
        const handle = traceHandle?.startToolCall(name, args);
        if (handle) {
          const stack = toolCallStack.get(name) ?? [];
          stack.push(handle);
          toolCallStack.set(name, stack);
        }
      },
      onToolResult: (name, toolResult) => {
        this.deps.emitter.updateToolResult(name, toolResult);
        this.deps.emitter.updatePendingToolResult(name, toolResult);
        const stack = toolCallStack.get(name);
        if (stack && stack.length > 0) {
          stack.shift()?.end(toolResult);
        }
      },
      onStepStart: (info) => this.handleStepStart(info),
      onStep: (step) => this.handleStepFinished(step, traceHandle),
      onToolObserved: async (evt) => {
        await this.deps.persistence?.onToolCallRecorded?.({
          toolName: evt.toolName,
          input: evt.input,
          output: evt.output,
          batchId: evt.batchId,
        }).catch((e) =>
          console.error('[Persistence] onToolCallRecorded failed:', e),
        );
      },
    });
  }

  private async completeGenerateTurn(
    prepared: ActiveGenerateTurn,
    result: GenerateResult,
    traceHandle: GenerateTraceHandle | undefined,
  ): Promise<void> {
    this.finalizeNarrativeOutput(prepared, result);
    await this.persistGenerateResult(result);
    await this.compactMemoryIfNeeded();
    await this.syncGenerateDebugState();
    traceHandle?.end({ text: result.text, finishReason: result.finishReason });
  }

  private finalizeNarrativeOutput(
    prepared: ActiveGenerateTurn,
    result: GenerateResult,
  ): void {
    prepared.narrativeRuntime.finalizeParser();
    prepared.narrativeRuntime.flushPendingNarration();
    this.scenePatchEmitter = null;
    this.pendingNarrationFlusher = null;
    this.deps.emitter.stagePendingDebug({ finishReason: result.finishReason });
    this.deps.emitter.finalizeStreamingEntry();
  }

  private async persistGenerateResult(result: GenerateResult): Promise<void> {
    if (this.currentNarrativeBuffer) {
      await this.deps.memory.appendTurn({
        turn: this.deps.turn,
        role: 'generate',
        content: this.currentNarrativeBuffer,
        tokenCount: estimateTokens(this.currentNarrativeBuffer),
      });
    }

    if (this.currentNarrativeBuffer) {
      await this.deps.persistence?.onNarrativeSegmentFinalized({
        entry: {
          role: 'generate',
          content: this.currentNarrativeBuffer,
          reasoning: this.currentReasoningBuffer || undefined,
          finishReason: result.finishReason,
        },
        batchId: this.currentStepBatchId,
      }).catch((e) => console.error('[Persistence] onNarrativeSegmentFinalized (final) failed:', e));
      this.currentNarrativeBuffer = '';
      this.currentReasoningBuffer = '';
    }

    const memSnapGen = await this.deps.memory.snapshot();
    await this.deps.persistence?.onGenerateComplete({
      memorySnapshot: memSnapGen,
      preview: result.text
        ? extractPlainText(result.text).slice(0, 80).replace(/\n/g, ' ').trim()
        : null,
      currentScene: this.currentScene,
    }).catch((e) => console.error('[Persistence] onGenerateComplete failed:', e));
  }

  private async compactMemoryIfNeeded(): Promise<void> {
    this.deps.emitter.setStatus('compressing');
    await this.deps.memory.maybeCompact();
  }

  private async syncGenerateDebugState(): Promise<void> {
    const memSnap = await this.deps.memory.snapshot();
    const entries = (memSnap.entries as unknown[] | undefined) ?? [];
    const summaries = (memSnap.summaries as string[] | undefined) ?? [];
    this.deps.emitter.updateDebug({
      stateVars: this.deps.stateStore.getAll(),
      totalTurns: this.deps.stateStore.getTurn(),
      memoryEntryCount: entries.length,
      memorySummaryCount: summaries.length,
    });
  }

  private failGenerateTurn(
    error: unknown,
    traceHandle: GenerateTraceHandle | undefined,
  ): void {
    this.deps.emitter.finalizeStreamingEntry();
    traceHandle?.error(
      error instanceof Error ? error.message : String(error),
      'generate',
    );
    traceHandle?.end({ error: String(error) });
    this.deps.emitter.setError(error instanceof Error ? error.message : String(error));
  }

  private createPrepareStepSystem(
    context: Awaited<ReturnType<typeof assembleContext>>,
    runAssemble: (focus: ReturnType<typeof computeFocus>) => Promise<Awaited<ReturnType<typeof assembleContext>>>,
    traceHandle: GenerateTraceHandle | undefined,
  ): PrepareStepSystem {
    const focusKey = (focus: ReturnType<typeof computeFocus>) =>
      JSON.stringify({ scene: focus.scene, characters: focus.characters, stage: focus.stage });
    let cachedFocusKey = focusKey(computeFocus(this.deps.stateStore.getAll()));
    let cachedSystemPrompt = context.systemPrompt;

    return async ({ stepNumber }) => {
      if (stepNumber === 0) return undefined;

      const curFocus = computeFocus(this.deps.stateStore.getAll());
      const curKey = focusKey(curFocus);
      if (curKey === cachedFocusKey) {
        return cachedSystemPrompt === context.systemPrompt ? undefined : cachedSystemPrompt;
      }

      const prevFocus = JSON.parse(cachedFocusKey) as unknown;
      const newCtx = await runAssemble(curFocus);
      cachedFocusKey = curKey;
      cachedSystemPrompt = newCtx.systemPrompt;
      traceHandle?.event(
        'focus-refresh',
        { from: prevFocus, to: curFocus },
        { stepNumber },
      );
      return newCtx.systemPrompt;
    };
  }

  private computeActiveSegmentIds(): string[] {
    return this.deps.segments
      .filter((segment) => {
        if (!segment.injectionRule) return true;
        try {
          const vars = this.deps.stateStore.getAll();
          const keys = Object.keys(vars);
          const values = keys.map((key) => vars[key]);
          const fn = new Function(
            ...keys,
            `try { return !!(${segment.injectionRule.condition}); } catch { return false; }`,
          );
          return fn(...values) as boolean;
        } catch {
          return false;
        }
      })
      .map((segment) => segment.id);
  }

  private createTurnTools(): ReturnType<typeof createTools> {
    return createTools({
      stateStore: this.deps.stateStore,
      memory: this.deps.memory,
      segments: [...this.deps.segments],
      recordPendingSignal: async (options) => {
        await this.recordPendingSignal(options);
      },
      onSetMood: () => {
        // TODO: connect to mood-capable output consumers.
      },
      onScenarioEnd: (reason) => {
        this.deps.onScenarioEnd(reason);
      },
      onSceneChange: (patch) => {
        this.applyScenePatch(patch);
      },
    });
  }

  private createNarrativeRuntime(
    traceHandle: GenerateTraceHandle | undefined,
  ): NarrativeRuntime {
    return this.deps.protocolVersion === 'v2-declarative-visual'
      ? this.createDeclarativeNarrativeRuntime(traceHandle)
      : this.createToolDrivenNarrativeRuntime(traceHandle);
  }

  private createDeclarativeNarrativeRuntime(
    traceHandle: GenerateTraceHandle | undefined,
  ): NarrativeRuntime {
    const parserV2: NarrativeParserV2 = createParserV2({
      manifest: this.deps.parserManifest!,
      turnNumber: this.deps.turn,
      startIndex: 0,
      initialScene: copyScene(this.currentScene),
    });

    const drainBatch = (batch: NarrativeBatch) => {
      for (const sentence of batch.sentences) {
        if (sentence.kind !== 'scene_change') {
          this.currentScene = copyScene(sentence.sceneRef);
        }
        this.deps.emitter.appendSentence(sentence);
        if (sentence.kind === 'dialogue' && sentence.truncated) {
          this.traceNarrativeTruncation(traceHandle, {
            kind: 'dialogue',
            speaker: sentence.pf.speaker,
            partialLength: sentence.text.length,
          });
        }
        if (sentence.kind === 'narration' && sentence.truncated) {
          this.traceNarrativeTruncation(traceHandle, {
            kind: 'narration',
            partialLength: sentence.text.length,
          });
        }
      }

      if (batch.scratches.length > 0) {
        traceHandle?.event(
          'ir-scratch',
          {
            count: batch.scratches.length,
            totalChars: batch.scratches.reduce((n, scratch) => n + scratch.text.length, 0),
          },
          { turn: this.deps.turn },
        );
      }

      for (const degrade of batch.degrades) {
        traceHandle?.event(
          `ir-degrade:${degrade.code}`,
          degrade.detail ? { detail: degrade.detail } : {},
          { turn: this.deps.turn },
        );
      }
    };

    this.scenePatchEmitter = null;
    return {
      feedTextChunk: (chunk) => drainBatch(parserV2.feed(chunk)),
      finalizeParser: () => drainBatch(parserV2.finalize()),
      flushPendingNarration: () => {},
    };
  }

  private createToolDrivenNarrativeRuntime(
    traceHandle: GenerateTraceHandle | undefined,
  ): NarrativeRuntime {
    let turnSentenceIndex = 0;
    const emitSentence = (draft: GeneratedSentenceDraft) => {
      this.deps.emitter.appendSentence(
        this.createGeneratedSentence(draft, turnSentenceIndex),
      );
      turnSentenceIndex += 1;
    };

    const narrationAcc = createNarrationAccumulator((para) =>
      emitSentence({ kind: 'narration', text: para }),
    );
    const flushPendingNarration = () => narrationAcc.flush();

    const narrativeParser = new NarrativeParser({
      onNarrationChunk: (text) => narrationAcc.push(text),
      onDialogueStart: () => {
        flushPendingNarration();
      },
      onDialogueEnd: (pf, fullText, truncated) => {
        emitSentence({ kind: 'dialogue', text: fullText, pf, truncated });
        if (truncated) {
          this.traceNarrativeTruncation(traceHandle, {
            kind: 'dialogue',
            speaker: pf.speaker,
            partialLength: fullText.length,
          });
        }
      },
    });

    this.scenePatchEmitter = (transition) => {
      flushPendingNarration();
      this.deps.emitter.emitSceneChange(this.currentScene, transition);
      emitSentence({ kind: 'scene_change', scene: copyScene(this.currentScene), transition });
      traceHandle?.event(
        'scene-change',
        { scene: this.currentScene, transition },
        { turn: this.deps.turn },
      );
    };

    return {
      feedTextChunk: (chunk) => narrativeParser.push(chunk),
      finalizeParser: () => narrativeParser.finalize(),
      flushPendingNarration,
    };
  }

  private createGeneratedSentence(
    draft: GeneratedSentenceDraft,
    index: number,
  ): Sentence {
    const base = { turnNumber: this.deps.turn, index };

    if (draft.kind === 'narration') {
      return { kind: 'narration', text: draft.text, sceneRef: copyScene(this.currentScene), ...base };
    }

    if (draft.kind === 'dialogue') {
      return {
        kind: 'dialogue',
        text: draft.text,
        pf: draft.pf,
        sceneRef: copyScene(this.currentScene),
        ...base,
        ...(draft.truncated !== undefined ? { truncated: draft.truncated } : {}),
      };
    }

    return {
      kind: 'scene_change',
      scene: draft.scene,
      ...(draft.transition !== undefined ? { transition: draft.transition } : {}),
      ...base,
    };
  }

  private traceNarrativeTruncation(
    traceHandle: GenerateTraceHandle | undefined,
    event:
      | { kind: 'dialogue'; speaker: string; partialLength: number }
      | { kind: 'narration'; partialLength: number },
  ): void {
    traceHandle?.event(
      'narrative-truncation',
      event.kind === 'dialogue'
        ? { speaker: event.speaker, partialLength: event.partialLength }
        : { partialLength: event.partialLength },
      { turn: this.deps.turn, kind: event.kind },
    );
  }

  private handleStepStart(info: StepStartInfo): void {
    this.rememberMainStepBatch(info);
  }

  private handleStepFinished(
    step: StepInfo,
    traceHandle: GenerateTraceHandle | undefined,
  ): void {
    this.rememberMainStepBatch(step);
    traceHandle?.recordStep(toTraceStepRecord(step));
  }

  private rememberMainStepBatch(step: Pick<StepInfo, 'batchId' | 'isFollowup'>): void {
    if (!step.isFollowup) {
      this.currentStepBatchId = step.batchId ?? null;
    }
  }

  private async recordPendingSignal(options: SignalInputOptions): Promise<void> {
    const hint = options.hint ?? '';
    const choices = options.choices ?? [];

    this.pendingNarrationFlusher?.();

    if (this.currentNarrativeBuffer) {
      const buffered = this.currentNarrativeBuffer;
      const bufferedReasoning = this.currentReasoningBuffer;
      this.currentNarrativeBuffer = '';
      this.currentReasoningBuffer = '';

      try {
        await this.deps.memory.appendTurn({
          turn: this.deps.turn,
          role: 'generate',
          content: buffered,
          tokenCount: estimateTokens(buffered),
        });
      } catch (e) {
        console.error('[recordPendingSignal] memory.appendTurn failed:', e);
      }

      try {
        await this.deps.persistence?.onNarrativeSegmentFinalized({
          entry: {
            role: 'generate',
            content: buffered,
            reasoning: bufferedReasoning || undefined,
            finishReason: 'signal-input-preflush',
          },
          batchId: this.currentStepBatchId,
        });
      } catch (e) {
        console.error('[recordPendingSignal] onNarrativeSegmentFinalized failed:', e);
      }
    }

    this.pendingSignal = {
      hint,
      choices,
      batchId: this.currentStepBatchId,
    };

    if (hint) {
      this.emitSignalInputSentence(hint, choices);
      await this.deps.persistence?.onSignalInputRecorded?.({
        hint,
        choices,
        batchId: this.currentStepBatchId,
      }).catch((e) => console.error('[Persistence] onSignalInputRecorded failed:', e));
    }
  }

  private emitSignalInputSentence(hint: string, choices: string[]): void {
    this.deps.emitter.appendSentence({
      kind: 'signal_input',
      hint,
      choices,
      sceneRef: copyScene(this.currentScene),
      turnNumber: this.deps.turn,
      index: Date.now(),
    });
  }

  private applyScenePatch(patch: ScenePatch): void {
    const { scene, transition } = applyScenePatchToState(this.currentScene, patch);
    this.currentScene = scene;
    this.scenePatchEmitter?.(transition);
  }

  private snapshotResult(stopped: boolean): GenerateTurnResult {
    return {
      currentScene: copyScene(this.currentScene),
      pendingSignal: this.pendingSignal
        ? {
            hint: this.pendingSignal.hint,
            choices: [...this.pendingSignal.choices],
            batchId: this.pendingSignal.batchId,
          }
        : null,
      stopped,
    };
  }
}

const copyScene = (scene: SceneState): SceneState => ({
  background: scene.background,
  sprites: scene.sprites.map((sprite) => ({ ...sprite })),
});
