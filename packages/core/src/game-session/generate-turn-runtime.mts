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
  PromptSegment,
  ProtocolVersion,
  SceneState,
  ScratchBlock,
  Sentence,
} from '#internal/types';
import type { StateStore } from '#internal/state-store';
import type { Memory } from '#internal/memory/types';
import { estimateTokens } from '#internal/tokens';
import { assembleContext, evaluateCondition } from '#internal/context-assembler';
import { computeFocus, focusEquals } from '#internal/focus';
import { createTools, getEnabledTools } from '#internal/tool-executor';
import type { SignalInputOptions } from '#internal/tool-executor';
import type { GenerateOptions, GenerateResult, LLMClient, StepInfo } from '#internal/llm-client';
import { extractPlainText } from '#internal/narrative-parser';
import {
  createParser as createParserV2,
  type DegradeEvent as DegradeEventV2,
  type NarrativeParser as NarrativeParserV2,
  type ParserManifest,
} from '#internal/narrative-parser-v2';
import {
  rewriteNarrative,
  summarizeManifest,
  type ParserVerifyResult,
  type RewriteInvoke,
  type RewriteResult,
} from '#internal/narrative-rewrite';
import { serializeMessagesForDebug } from '#internal/messages-builder';
import { resolveRuntimeProtocolVersion } from '#internal/protocol-version';
import type { CoreEventSink, RuntimeSentence, StepId, TurnId } from '#internal/game-session/core-events';
import {
  batchId as toBatchId,
  createInputRequest,
  stepId as toStepId,
  turnId as toTurnId,
} from '#internal/game-session/core-events';
import type {
  GenerateTraceHandle,
  SessionTracing,
  ToolCallTraceHandle,
} from '#internal/game-session/types';

type PrepareStepSystem = NonNullable<GenerateOptions['prepareStepSystem']>;

type StepStartInfo = {
  stepNumber: number;
  batchId: string;
  isFollowup: boolean;
};

type TraceStepRecord = Parameters<GenerateTraceHandle['recordStep']>[0];

type NarrativeBatch = {
  readonly sentences: ReadonlyArray<Sentence>;
  readonly scratches: ReadonlyArray<ScratchBlock>;
  readonly degrades: ReadonlyArray<DegradeEventV2>;
};

interface NarrativeRuntime {
  feedTextChunk(chunk: string): void;
  finalizeParser(): void;
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
  readonly stateStore: StateStore;
  readonly memory: Memory;
  readonly llmClient: Pick<LLMClient, 'generate'>;
  readonly segments: ReadonlyArray<PromptSegment>;
  readonly enabledTools: ReadonlyArray<string>;
  readonly tokenBudget: number;
  readonly initialPrompt?: string;
  readonly assemblyOrder?: ReadonlyArray<string>;
  readonly disabledSections?: ReadonlyArray<string>;
  readonly tracing?: SessionTracing;
  readonly protocolVersion: ProtocolVersion;
  readonly parserManifest?: ParserManifest;
  readonly characters: ReadonlyArray<CharacterAsset>;
  readonly backgrounds: ReadonlyArray<BackgroundAsset>;
  readonly currentScene: SceneState;
  readonly coreEventSink?: CoreEventSink;
  /**
   * narrative-rewrite invoke。注入此项后，每轮主 LLM 路径完成后会触发 rewrite
   * 把 raw fullText 归一化成符合 IVN XML 协议的 tagged 输出。
   * PR1：仅记录到 trace + emit core event，不替换 currentNarrativeBuffer。
   */
  readonly rewriter?: RewriteInvoke;
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

const LEGACY_VISUAL_TOOLS = new Set(['change_scene', 'change_sprite', 'clear_stage']);

export function createGenerateTurnRuntime(deps: GenerateTurnRuntimeDeps): GenerateTurnRuntime {
  const protocolVersion = resolveRuntimeProtocolVersion(deps.protocolVersion);
  if (!deps.parserManifest) {
    throw new Error(`[GenerateTurnRuntime] protocolVersion="${protocolVersion}" requires parserManifest`);
  }
  return new DefaultGenerateTurnRuntime({ ...deps, protocolVersion });
}

function toTraceStepRecord(step: StepInfo): TraceStepRecord {
  return Object.fromEntries(
    TRACE_STEP_FIELDS.map((field) => [field, step[field]]),
  ) as TraceStepRecord;
}

/**
 * narrative-rewrite 用的二次校验 helper。新建一个 parser-v2 实例 feed 一遍
 * rewrite 输出，统计 sentence/scratch 数和 degrade。纯函数（构造一次性 parser
 * 不修改任何外部 state），可以反复调用。
 */
function verifyParseWithParserV2(
  text: string,
  manifest: ParserManifest,
): ParserVerifyResult {
  const parser = createParserV2({
    manifest,
    turnNumber: 0,
    startIndex: 0,
    initialScene: { background: null, sprites: [] },
  });
  let sentenceCount = 0;
  let scratchCount = 0;
  const degrades: DegradeEventV2[] = [];
  const collect = (batch: NarrativeBatch) => {
    sentenceCount += batch.sentences.length;
    scratchCount += batch.scratches.length;
    if (batch.degrades.length > 0) degrades.push(...batch.degrades);
  };
  collect(parser.feed(text));
  collect(parser.finalize());
  return { sentenceCount, scratchCount, degrades };
}

interface DrainBatchContext {
  readonly initialScene: SceneState;
  readonly publish: (event: Parameters<CoreEventSink['publish']>[0]) => void;
  readonly traceHandle: GenerateTraceHandle | undefined;
  readonly turnId: TurnId;
  readonly turn: number;
  /** Closure so the read happens at publish time, not at drain entry. */
  readonly getBatchId: () => string | null;
}

/**
 * Project a parser-v2 batch into core events + tracing side effects, returning
 * the scene after the last non-`scene_change` sentence (caller assigns it back
 * to its mutable `currentScene`).
 *
 * Side effects emitted in fixed order:
 *   1. per-sentence `narrative-truncation` trace events (dialogue / narration)
 *   2. one aggregated `ir-scratch` event if scratches non-empty
 *   3. per-degrade `ir-degrade:<code>` event
 *   4. one `narrative-batch-emitted` core event if anything was in the batch
 */
function drainNarrativeBatch(
  batch: NarrativeBatch,
  ctx: DrainBatchContext,
): SceneState {
  let scene = ctx.initialScene;

  for (const sentence of batch.sentences) {
    if (sentence.kind !== 'scene_change') {
      scene = copyScene(sentence.sceneRef);
    }
    if (sentence.kind === 'dialogue' && sentence.truncated) {
      traceNarrativeTruncation(ctx.traceHandle, ctx.turn, {
        kind: 'dialogue',
        speaker: sentence.pf.speaker,
        partialLength: sentence.text.length,
      });
    } else if (sentence.kind === 'narration' && sentence.truncated) {
      traceNarrativeTruncation(ctx.traceHandle, ctx.turn, {
        kind: 'narration',
        partialLength: sentence.text.length,
      });
    }
  }

  if (batch.scratches.length > 0) {
    ctx.traceHandle?.event(
      'ir-scratch',
      {
        count: batch.scratches.length,
        totalChars: batch.scratches.reduce((n, scratch) => n + scratch.text.length, 0),
      },
      { turn: ctx.turn },
    );
  }

  for (const degrade of batch.degrades) {
    ctx.traceHandle?.event(
      `ir-degrade:${degrade.code}`,
      degrade.detail ? { detail: degrade.detail } : {},
      { turn: ctx.turn },
    );
  }

  if (
    batch.sentences.length > 0 ||
    batch.scratches.length > 0 ||
    batch.degrades.length > 0
  ) {
    ctx.publish({
      type: 'narrative-batch-emitted',
      turnId: ctx.turnId,
      batchId: toBatchId(ctx.getBatchId()),
      sentences: batch.sentences.filter(isRuntimeSentence).map(copyRuntimeSentence),
      scratches: batch.scratches.map((scratch) => ({ ...scratch })),
      degrades: batch.degrades.map((degrade) => ({ ...degrade })),
      sceneAfter: copyScene(scene),
    });
  }

  return scene;
}

function traceNarrativeTruncation(
  traceHandle: GenerateTraceHandle | undefined,
  turn: number,
  event:
    | { kind: 'dialogue'; speaker: string; partialLength: number }
    | { kind: 'narration'; partialLength: number },
): void {
  traceHandle?.event(
    'narrative-truncation',
    event.kind === 'dialogue'
      ? { speaker: event.speaker, partialLength: event.partialLength }
      : { partialLength: event.partialLength },
    { turn, kind: event.kind },
  );
}

class DefaultGenerateTurnRuntime implements GenerateTurnRuntime {
  private readonly turnId: TurnId;
  private currentScene: SceneState;
  private currentNarrativeBuffer = '';
  private currentReasoningBuffer = '';
  private currentStepBatchId: string | null = null;
  private currentStepId: StepId | null = null;
  private pendingSignal: GenerateTurnPendingSignal | null = null;
  private abortController: AbortController | null = null;
  /** parser-v2 这一轮 emit 的 Sentence 累计数（含 dialogue/narration/scene_change 等） */
  private sentenceCountThisTurn = 0;
  /** parser-v2 这一轮 emit 的 ScratchBlock 累计数 */
  private scratchCountThisTurn = 0;
  /** parser-v2 这一轮 emit 的 degrade 累计列表 */
  private degradesThisTurn: DegradeEventV2[] = [];
  /** turn 起始时的 scene 快照——rewrite replay 时回滚到这里 */
  private turnInitialScene: SceneState = { background: null, sprites: [] };
  /**
   * 整个 turn 累计 raw text（改进 B，2026-04-26）。
   *
   * 跟 currentNarrativeBuffer 平行 —— buffer 在 signal_input_needed 触发的
   * recordPendingSignal 里被 preflush 清空，但本字段只增不减，turn 结束才 reset。
   * 让 rewrite 看到完整 turn 的 raw（含 preflush 已落库的那段），不被切断。
   *
   * 仅 in-memory，不落库。
   */
  private currentTurnRawText = '';
  /** rewrite 是否已应用（用于 persistGenerateResult 选择 reason） */
  private rewriteAppliedThisTurn = false;

  constructor(private readonly deps: GenerateTurnRuntimeDeps) {
    this.turnId = toTurnId(deps.turn);
    this.currentScene = copyScene(deps.currentScene);
  }

  async run(): Promise<GenerateTurnResult> {
    const traceHandle = this.deps.tracing?.startGenerateTrace(this.deps.turn);
    const toolCallStack = new Map<string, ToolCallTraceHandle[]>();
    const toolInputStack = new Map<string, unknown[]>();
    await this.publishDurable({
      type: 'generate-turn-started',
      turn: this.deps.turn,
      turnId: this.turnId,
    });

    try {
      const prepared = await this.prepareGenerateTurn(traceHandle);
      if (!this.deps.isActive()) {
        traceHandle?.end({ stopped: true });
        return this.snapshotResult(true);
      }
      const activeTurn = this.beginGenerateTurn(prepared, traceHandle);
      const result = await this.runLLMGenerate(
        activeTurn,
        traceHandle,
        toolCallStack,
        toolInputStack,
      );
      await this.completeGenerateTurn(activeTurn, result, traceHandle);
    } catch (error) {
      if (!this.deps.isActive()) {
        return this.snapshotResult(true);
      }
      this.failGenerateTurn(error, traceHandle);
    } finally {
      this.currentStepBatchId = null;
      this.currentStepId = null;
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
    const tools = getEnabledTools(
      allTools,
      this.deps.enabledTools.filter((toolName) => !LEGACY_VISUAL_TOOLS.has(toolName)),
    );
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

    this.publish({
      type: 'context-assembled',
      turnId: this.turnId,
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
    this.sentenceCountThisTurn = 0;
    this.scratchCountThisTurn = 0;
    this.degradesThisTurn = [];
    this.currentTurnRawText = '';
    this.rewriteAppliedThisTurn = false;
    // 记 turn 起始 scene；rewrite 替换时 currentScene 要回滚到这里再重 feed parser
    this.turnInitialScene = copyScene(this.currentScene);
    this.publish({ type: 'assistant-message-started', turnId: this.turnId });

    const narrativeRuntime = this.createNarrativeRuntime(traceHandle);

    return { ...prepared, narrativeRuntime };
  }

  private async runLLMGenerate(
    prepared: ActiveGenerateTurn,
    traceHandle: GenerateTraceHandle | undefined,
    toolCallStack: Map<string, ToolCallTraceHandle[]>,
    toolInputStack: Map<string, unknown[]>,
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
        // 改进 B：currentTurnRawText 跟 buffer 平行累加，但 preflush 不清空
        // 让 rewrite 看到完整 turn 的 raw（含 preflush 已落库那段）
        this.currentTurnRawText += chunk;
        this.publish({
          type: 'assistant-text-delta',
          turnId: this.turnId,
          stepId: this.currentStepId,
          batchId: toBatchId(this.currentStepBatchId),
          text: chunk,
        });
        prepared.narrativeRuntime.feedTextChunk(chunk);
      },
      onReasoningChunk: (chunk) => {
        this.currentReasoningBuffer += chunk;
        this.publish({
          type: 'assistant-reasoning-delta',
          turnId: this.turnId,
          stepId: this.currentStepId,
          batchId: toBatchId(this.currentStepBatchId),
          text: chunk,
        });
      },
      onToolCall: (name, args) => {
        const inputStack = toolInputStack.get(name) ?? [];
        inputStack.push(args);
        toolInputStack.set(name, inputStack);
        this.publish({
          type: 'tool-call-started',
          turnId: this.turnId,
          stepId: this.currentStepId,
          batchId: toBatchId(this.currentStepBatchId),
          toolName: name,
          input: args,
        });
        const handle = traceHandle?.startToolCall(name, args);
        if (handle) {
          const stack = toolCallStack.get(name) ?? [];
          stack.push(handle);
          toolCallStack.set(name, stack);
        }
      },
      onToolResult: (name, toolResult) => {
        const input = toolInputStack.get(name)?.shift();
        this.publish({
          type: 'tool-call-finished',
          turnId: this.turnId,
          stepId: this.currentStepId,
          batchId: toBatchId(this.currentStepBatchId),
          toolName: name,
          input,
          output: toolResult,
        });
        const stack = toolCallStack.get(name);
        if (stack && stack.length > 0) {
          stack.shift()?.end(toolResult);
        }
      },
      onStepStart: (info) => this.handleStepStart(info),
      onStep: (step) => this.handleStepFinished(step, traceHandle),
    });
  }

  private async completeGenerateTurn(
    prepared: ActiveGenerateTurn,
    result: GenerateResult,
    traceHandle: GenerateTraceHandle | undefined,
  ): Promise<void> {
    this.finalizeNarrativeOutput(prepared, result);
    await this.runRewriteIfEnabled(result, traceHandle);
    await this.persistGenerateResult(result);
    await this.compactMemoryIfNeeded();
    await this.syncGenerateDebugState();
    traceHandle?.end({ text: result.text, finishReason: result.finishReason });
  }

  /**
   * narrative-rewrite 阶段。在 parser-v2 第一次跑完之后、persistGenerateResult
   * 之前触发。
   *
   * - PR1：仅 trace + emit core event，不替换 currentNarrativeBuffer
   * - PR2：rewrite ok 时**替换** currentNarrativeBuffer，并 emit narrative-turn-reset
   *   让 UI 清掉本 turn 的旧 sentence；新建 parser-v2 实例 feed rewrite text
   *   重新 emit narrative-batch-emitted。落库的 narrative-segment-finalized.entry.content
   *   是 rewrite 后的 tagged 版本
   */
  private async runRewriteIfEnabled(
    _result: GenerateResult,
    traceHandle: GenerateTraceHandle | undefined,
  ): Promise<void> {
    const invoke = this.deps.rewriter;
    if (!invoke) return;
    if (!this.deps.parserManifest) return;
    // 改进 B：rewrite 用整 turn 的 raw（含被 preflush 切走的部分），不只用
    // currentNarrativeBuffer。这样 trace 227cb1d0 那种 prose 在主路径中段
    // 被 preflush 落库后仍然能进入 rewrite 处理。
    const rawText = this.currentTurnRawText;
    if (rawText.trim().length === 0) return;

    const looksBroken =
      this.sentenceCountThisTurn === 0 ||
      this.degradesThisTurn.length > 0 ||
      (this.scratchCountThisTurn > 0 && this.sentenceCountThisTurn === 0);

    this.publish({
      type: 'rewrite-attempted',
      turnId: this.turnId,
      rawTextLength: rawText.length,
      looksBroken,
    });

    const parserManifest = this.deps.parserManifest;
    const rewriteResult: RewriteResult = await rewriteNarrative(
      {
        rawText,
        parserView: {
          sentences: [],
          scratchCount: this.scratchCountThisTurn,
          degrades: this.degradesThisTurn,
          looksBroken,
        },
        manifest: summarizeManifest(parserManifest),
        turn: this.deps.turn,
        abortSignal: this.abortController?.signal,
      },
      {
        invoke,
        verifyParse: (text) => verifyParseWithParserV2(text, parserManifest),
        parserManifest,
        // PR2：失败重试 1 次（temperature 默认；rewriter 内部不动 temperature）
        maxRetries: 1,
        trace: traceHandle
          ? {
              start: (input) => {
                const span = traceHandle.startNestedGeneration({
                  name: 'narrative-rewrite',
                  input: {
                    system: input.systemPrompt,
                    user: input.userMessage,
                  },
                  metadata: { turn: this.deps.turn, looksBroken },
                });
                return {
                  end: (opts) => {
                    span.end({
                      text: opts.text,
                      finishReason: opts.finishReason,
                      inputTokens: opts.inputTokens,
                      outputTokens: opts.outputTokens,
                      error: opts.error,
                      metadata: opts.fallbackReason
                        ? { fallbackReason: opts.fallbackReason }
                        : undefined,
                    });
                  },
                };
              },
            }
          : undefined,
      },
    );

    // 替换决策：仅当 status='ok' + 文本真的不一样才替换
    let applied = false;
    if (
      rewriteResult.status === 'ok' &&
      rewriteResult.text.trim().length > 0 &&
      rewriteResult.text !== rawText
    ) {
      this.replayWithRewrittenText(rewriteResult.text, traceHandle);
      applied = true;
      // 改进 B：标记 turn 已被 rewrite 替换；persistGenerateResult 会落
      // reason='rewrite-applied' 替代 'generate-complete'，messages-builder
      // 投影时跳过同 turn 内其他 segment（含 'signal-input-preflush' 那条 prose）
      this.rewriteAppliedThisTurn = true;
    }

    this.publish({
      type: 'rewrite-completed',
      turnId: this.turnId,
      status: rewriteResult.status,
      fallbackReason: rewriteResult.fallbackReason,
      attempts: rewriteResult.attempts,
      latencyMs: rewriteResult.latencyMs,
      inputTokens: rewriteResult.inputTokens,
      outputTokens: rewriteResult.outputTokens,
      model: rewriteResult.model,
      outputTextLength: rewriteResult.text.length,
      verifiedSentenceCount: rewriteResult.verified?.sentenceCount ?? null,
      applied,
    });
  }

  /**
   * 用 rewrite 后的 text 重 feed parser-v2，emit 新一波 narrative-batch-emitted
   * 给 UI。流程：
   *   1. 回滚 currentScene 到 turn 起始状态（parser-v2 在 turn 内是单调推进的）
   *   2. emit narrative-turn-reset → UI 清掉这一 turn 已经渲染的 sentence
   *   3. 新建 parser-v2 实例 feed rewrite text → finalize → emit batch（自动重 emit）
   *   4. 替换 currentNarrativeBuffer = rewrittenText
   */
  private replayWithRewrittenText(
    rewrittenText: string,
    traceHandle: GenerateTraceHandle | undefined,
  ): void {
    if (!this.deps.parserManifest) return;
    // 1. 回滚 scene
    this.currentScene = copyScene(this.turnInitialScene);

    // 2. 通知 UI 清空 turn 渲染
    this.publish({
      type: 'narrative-turn-reset',
      turnId: this.turnId,
      reason: 'rewrite-applied',
      sceneAfter: copyScene(this.currentScene),
    });

    // 3. 重置 counters + 新建 parser-v2 + feed
    this.sentenceCountThisTurn = 0;
    this.scratchCountThisTurn = 0;
    this.degradesThisTurn = [];

    const replayParser = createParserV2({
      manifest: this.deps.parserManifest,
      turnNumber: this.deps.turn,
      startIndex: 0,
      initialScene: copyScene(this.currentScene),
    });

    const drain = (batch: NarrativeBatch) => {
      this.currentScene = drainNarrativeBatch(batch, {
        initialScene: this.currentScene,
        publish: (event) => this.publish(event),
        traceHandle,
        turnId: this.turnId,
        turn: this.deps.turn,
        getBatchId: () => this.currentStepBatchId,
      });
      this.sentenceCountThisTurn += batch.sentences.length;
      this.scratchCountThisTurn += batch.scratches.length;
      if (batch.degrades.length > 0) this.degradesThisTurn.push(...batch.degrades);
    };
    drain(replayParser.feed(rewrittenText));
    drain(replayParser.finalize());

    // 4. 替换 buffer—— persistGenerateResult 用这个值
    this.currentNarrativeBuffer = rewrittenText;
  }

  private finalizeNarrativeOutput(
    prepared: ActiveGenerateTurn,
    result: GenerateResult,
  ): void {
    prepared.narrativeRuntime.finalizeParser();
    this.publish({
      type: 'assistant-message-finalized',
      turnId: this.turnId,
      finishReason: result.finishReason,
    });
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
      // 改进 B：rewrite 已应用时落 reason='rewrite-applied'，messages-builder
      // 看到此 reason 会跳过同 turn 内其他 segment（含 'signal-input-preflush'
      // 那条 prose）—— 让下一轮 LLM 看到的 history 只有 rewrite 后的版本。
      const reason = this.rewriteAppliedThisTurn
        ? ('rewrite-applied' as const)
        : ('generate-complete' as const);
      await this.publishDurable({
        type: 'narrative-segment-finalized',
        turnId: this.turnId,
        stepId: this.currentStepId,
        batchId: toBatchId(this.currentStepBatchId),
        reason,
        entry: {
          role: 'generate',
          content: this.currentNarrativeBuffer,
          reasoning: this.currentReasoningBuffer || undefined,
          finishReason: result.finishReason,
        },
        sceneAfter: copyScene(this.currentScene),
      });
      this.currentNarrativeBuffer = '';
      this.currentReasoningBuffer = '';
    }

    const memSnapGen = await this.deps.memory.snapshot();
    await this.publishDurable({
      type: 'generate-turn-completed',
      turnId: this.turnId,
      finishReason: result.finishReason,
      preview: result.text
        ? extractPlainText(result.text).slice(0, 80).replace(/\n/g, ' ').trim()
        : null,
      snapshot: {
        turn: this.deps.turn,
        stateVars: this.deps.stateStore.getAll(),
        memorySnapshot: memSnapGen,
        currentScene: copyScene(this.currentScene),
      },
    });
  }

  private async compactMemoryIfNeeded(): Promise<void> {
    this.publish({ type: 'memory-compaction-started', turnId: this.turnId });
    await this.deps.memory.maybeCompact();
    this.publish({
      type: 'memory-compaction-completed',
      turnId: this.turnId,
      snapshot: {
        turn: this.deps.turn,
        stateVars: this.deps.stateStore.getAll(),
        memorySnapshot: await this.deps.memory.snapshot(),
        currentScene: copyScene(this.currentScene),
      },
    });
  }

  private async syncGenerateDebugState(): Promise<void> {
    const memSnap = await this.deps.memory.snapshot();
    const entries = (memSnap.entries as unknown[] | undefined) ?? [];
    const summaries = (memSnap.summaries as string[] | undefined) ?? [];
    this.publish({
      type: 'diagnostics-updated',
      diagnostics: {
        stateVars: this.deps.stateStore.getAll(),
        totalTurns: this.deps.stateStore.getTurn(),
        memoryEntryCount: entries.length,
        memorySummaryCount: summaries.length,
      },
    });
  }

  private failGenerateTurn(
    error: unknown,
    traceHandle: GenerateTraceHandle | undefined,
  ): void {
    traceHandle?.error(
      error instanceof Error ? error.message : String(error),
      'generate',
    );
    traceHandle?.end({ error: String(error) });
    this.publish({
      type: 'session-error',
      phase: 'generate',
      message: error instanceof Error ? error.message : String(error),
      snapshot: {
        turn: this.deps.turn,
        stateVars: this.deps.stateStore.getAll(),
        currentScene: copyScene(this.currentScene),
      },
    });
  }

  private createPrepareStepSystem(
    context: Awaited<ReturnType<typeof assembleContext>>,
    runAssemble: (focus: ReturnType<typeof computeFocus>) => Promise<Awaited<ReturnType<typeof assembleContext>>>,
    traceHandle: GenerateTraceHandle | undefined,
  ): PrepareStepSystem {
    let cachedFocus = computeFocus(this.deps.stateStore.getAll());
    let cachedSystemPrompt = context.systemPrompt;
    let everRefreshed = false;

    return async ({ stepNumber }) => {
      if (stepNumber === 0) return undefined;

      const curFocus = computeFocus(this.deps.stateStore.getAll());
      if (focusEquals(curFocus, cachedFocus)) {
        // focus 未变。第一次进入（everRefreshed=false）→ 沿用外层 system，
        // 让 AI SDK 走原始 systemPrompt；refresh 过后 → 喂回缓存的覆盖值，
        // 否则会从 step N>0 跳回 step 0 的 prompt。
        return everRefreshed ? cachedSystemPrompt : undefined;
      }

      const newCtx = await runAssemble(curFocus);
      traceHandle?.event(
        'focus-refresh',
        { from: cachedFocus, to: curFocus },
        { stepNumber },
      );
      cachedFocus = curFocus;
      cachedSystemPrompt = newCtx.systemPrompt;
      everRefreshed = true;
      return cachedSystemPrompt;
    };
  }

  private computeActiveSegmentIds(): string[] {
    const vars = this.deps.stateStore.getAll();
    return this.deps.segments
      .filter((segment) =>
        !segment.injectionRule || evaluateCondition(segment.injectionRule.condition, vars),
      )
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
    });
  }

  private createNarrativeRuntime(
    traceHandle: GenerateTraceHandle | undefined,
  ): NarrativeRuntime {
    const parserV2: NarrativeParserV2 = createParserV2({
      manifest: this.deps.parserManifest!,
      turnNumber: this.deps.turn,
      startIndex: 0,
      initialScene: copyScene(this.currentScene),
    });

    const drain = (batch: NarrativeBatch) => {
      this.currentScene = drainNarrativeBatch(batch, {
        initialScene: this.currentScene,
        publish: (event) => this.publish(event),
        traceHandle,
        turnId: this.turnId,
        turn: this.deps.turn,
        getBatchId: () => this.currentStepBatchId,
      });
      // 累计 parser-v2 这一轮的产出，给 rewrite 阶段当 hint
      this.sentenceCountThisTurn += batch.sentences.length;
      this.scratchCountThisTurn += batch.scratches.length;
      if (batch.degrades.length > 0) {
        this.degradesThisTurn.push(...batch.degrades);
      }
    };

    return {
      feedTextChunk: (chunk) => drain(parserV2.feed(chunk)),
      finalizeParser: () => drain(parserV2.finalize()),
    };
  }

  private handleStepStart(info: StepStartInfo): void {
    this.currentStepId = toStepId(this.deps.turn, info.stepNumber);
    this.rememberMainStepBatch(info);
    this.publish({
      type: 'llm-step-started',
      turnId: this.turnId,
      stepId: this.currentStepId,
      batchId: toBatchId(info.batchId)!,
      isFollowup: info.isFollowup,
    });
  }

  private handleStepFinished(
    step: StepInfo,
    traceHandle: GenerateTraceHandle | undefined,
  ): void {
    this.rememberMainStepBatch(step);
    traceHandle?.recordStep(toTraceStepRecord(step));
    this.persistStepReasoning(step);
  }

  private rememberMainStepBatch(step: Pick<StepInfo, 'batchId' | 'isFollowup'>): void {
    if (!step.isFollowup) {
      this.currentStepBatchId = step.batchId ?? null;
    }
  }

  /**
   * DeepSeek V4 thinking replay 修复。
   *
   * 两个 user 消息之间，只要发生过 tool_call，DeepSeek 要求这段 span 内每条
   * assistant message 都带 reasoning_content。narrative+tool step 的正文可能会
   * 被 signal-input preflush 合并到后续 batch，所以不能只给 tool-only step 写
   * reasoning 载体；每个非 follow-up、带 reasoning 的 main step 都要在自己的
   * batch 上追加一条 content='' 的 stub narrative entry。
   */
  private persistStepReasoning(step: StepInfo): void {
    if (
      step.isFollowup ||
      !step.batchId ||
      !step.reasoning
    ) {
      return;
    }

    const stepReasoning = step.reasoning;
    this.publish({
      type: 'narrative-segment-finalized',
      turnId: this.turnId,
      stepId: this.currentStepId,
      batchId: toBatchId(step.batchId),
      reason: 'step-reasoning',
      entry: {
        role: 'generate',
        content: '',
        reasoning: stepReasoning,
        finishReason: String(step.finishReason),
      },
      sceneAfter: copyScene(this.currentScene),
    });

    if (this.currentReasoningBuffer.endsWith(stepReasoning)) {
      this.currentReasoningBuffer = this.currentReasoningBuffer.slice(
        0,
        this.currentReasoningBuffer.length - stepReasoning.length,
      );
    }
  }

  private async recordPendingSignal(options: SignalInputOptions): Promise<void> {
    const hint = options.hint ?? '';
    const choices = options.choices ?? [];

    if (this.currentNarrativeBuffer) {
      const buffered = this.currentNarrativeBuffer;
      this.currentNarrativeBuffer = '';

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

      await this.publishDurable({
        type: 'narrative-segment-finalized',
        turnId: this.turnId,
        stepId: this.currentStepId,
        batchId: toBatchId(this.currentStepBatchId),
        reason: 'signal-input-preflush',
        entry: {
          role: 'generate',
          content: buffered,
          reasoning: undefined,
          finishReason: 'signal-input-preflush',
        },
        sceneAfter: copyScene(this.currentScene),
      });
    }

    this.pendingSignal = {
      hint,
      choices,
      batchId: this.currentStepBatchId,
    };

    if (hint) {
      await this.emitSignalInputSentence(hint, choices);
    }
  }

  private async emitSignalInputSentence(hint: string, choices: string[]): Promise<void> {
    const sentence = {
      kind: 'signal_input',
      hint,
      choices,
      sceneRef: copyScene(this.currentScene),
      turnNumber: this.deps.turn,
      index: Date.now(),
    } as const;
    await this.publishDurable({
      type: 'signal-input-recorded',
      turnId: this.turnId,
      batchId: toBatchId(this.currentStepBatchId),
      request: createInputRequest(hint, choices),
      sentence,
      sceneAfter: copyScene(this.currentScene),
    });
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

  private publish(event: Parameters<CoreEventSink['publish']>[0]): void {
    this.deps.coreEventSink?.publish(event);
  }

  private async publishDurable(event: Parameters<CoreEventSink['publish']>[0]): Promise<void> {
    this.publish(event);
    await this.deps.coreEventSink?.flushDurable?.();
  }
}

const copyScene = (scene: SceneState): SceneState => ({
  background: scene.background,
  sprites: scene.sprites.map((sprite) => ({ ...sprite })),
});

function isRuntimeSentence(sentence: Sentence): sentence is RuntimeSentence {
  return sentence.kind !== 'scene_change';
}

function copyRuntimeSentence(sentence: RuntimeSentence): RuntimeSentence {
  if (sentence.kind === 'dialogue') {
    return {
      ...sentence,
      pf: {
        speaker: sentence.pf.speaker,
        ...(sentence.pf.addressee ? { addressee: [...sentence.pf.addressee] } : {}),
        ...(sentence.pf.overhearers ? { overhearers: [...sentence.pf.overhearers] } : {}),
        ...(sentence.pf.eavesdroppers ? { eavesdroppers: [...sentence.pf.eavesdroppers] } : {}),
      },
      sceneRef: copyScene(sentence.sceneRef),
    };
  }

  return { ...sentence, sceneRef: copyScene(sentence.sceneRef) };
}
