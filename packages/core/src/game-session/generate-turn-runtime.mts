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
import type { ModelMessage } from 'ai';
import type { GenerateOptions, GenerateResult, LLMClient, StepInfo } from '#internal/llm-client';
import { extractPlainText } from '#internal/narrative-parser';
import {
  createParser as createParserV2,
  type DegradeEvent as DegradeEventV2,
  type NarrativeParser,
  type ParserManifest,
} from '#internal/narrative-parser-v2';
import {
  rewriteNarrative,
  summarizeManifest,
  type ParserVerifyResult,
  type RewriteInvoke,
  type RewriteResult,
} from '#internal/narrative-rewrite';
import {
  retryMainNarrative,
  type RetryMainInvoke,
  type RetryMainResult,
} from '#internal/narrative-retry-main';
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

interface GenerateTurnPrepared {
  readonly context: Awaited<ReturnType<typeof assembleContext>>;
  readonly tools: ReturnType<typeof getEnabledTools>;
  readonly prepareStepSystem: PrepareStepSystem;
}

/**
 * 路线 A：parser-v2 整轮 raw 一次性跑完后的解读结果。caller 用 stats 决定
 * rewrite/retry-main 路径，用 batches 在 finalText 确定后顺序 publish 给 sink。
 */
interface TextAnalysis {
  readonly batches: ReadonlyArray<NarrativeBatch>;
  readonly sentenceCount: number;
  readonly scratchCount: number;
  readonly degrades: ReadonlyArray<DegradeEventV2>;
  /** sentence 数 0 / 有 degrade / 全 scratch（rewriter looksBroken hint 用） */
  readonly looksBroken: boolean;
  /**
   * 跑完整段 text 后 scene 累积到的最终状态（非 scene_change sentence 的 sceneRef
   * 为参考）—— playFinalNarrative 用它推进 instance scene。
   */
  readonly finalScene: SceneState;
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
   */
  readonly rewriter?: RewriteInvoke;
  /**
   * narrative-retry-main invoke。**仅当 rewriter 也注入时有效**——retry-main
   * 是 rewriter 救不了的兜底层（main path sentenceCount=0 时并行触发，rewrite
   * 救不出正文就用 retry-main 输出再过一次 rewrite）。不注入则降级回旧行为：
   * sentenceCount=0 时单跑 rewrite，rewrite 失败就 fallback 到 raw。
   */
  readonly retryMain?: RetryMainInvoke;
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
  // 模型 tool-call 尝试 + 失败详情 —— 诊断 "tool-error 的具体 args 形态"
  // 用。staging 数据观察：300 trace / 195 含 tool-error，全部触发 followup
  // chain。recordStep 增强后下次抓样能直接看哪种 args 不过 zod。
  'toolCalls',
  'toolErrors',
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
 * 禁止用作 ad-hoc speaker 后缀的代词 / 关系代词列表。跟 engine-rules.mts
 * ADHOC_SPEAKER_RULES_V2 段保持同源——但因为 engine-rules 把列表写在 prompt
 * 文本里没单独 export，这里复制一份。
 *
 * 改动这里时同步更新 engine-rules.mts ADHOC_SPEAKER_RULES_V2 段的禁止列表。
 */
export const FORBIDDEN_ADHOC_SUFFIXES: ReadonlySet<string> = new Set([
  // 注：'我' 不在列表（某些剧本里"我"可以是 NPC 自述合法称呼）
  '你', '他', '她', '它', '他们', '她们', '咱', '自己', '主角',
  '另一人', '某人', '其中一个', '那个人', '谁',
]);

/**
 * 判断 ad-hoc dialogue speaker 的 detail 是不是禁止的关系代词后缀。
 * detail 形如 \`__npc__陌生男声\` 或 \`__npc__另一人\`——剥掉 \`__npc__\` 前缀
 * 后比对禁止列表。
 */
export function isForbiddenAdhocSuffix(detail: string | undefined): boolean {
  if (!detail) return false;
  const suffix = detail.startsWith('__npc__') ? detail.slice('__npc__'.length) : detail;
  return FORBIDDEN_ADHOC_SUFFIXES.has(suffix);
}

/**
 * 一条 degrade 是不是 rewriter 应该处理的"actionable"问题。
 *
 * - **non-actionable**（rewrite skip）：
 *   - \`dialogue-adhoc-speaker\` 且 detail 不是禁止代词后缀（合规身份描述）
 *   - \`container-truncated\`（rewriter 不能补内容，违反"不补剧情"硬约束）
 * - **actionable**（rewrite 应处理）：
 *   - \`dialogue-adhoc-speaker\` 且 detail 是禁止代词后缀 → 拆 narration
 *   - 其他所有 degrade（unknown-toplevel-tag / bare-text-outside-container 等）
 *
 * trace f6a68324 (session 25c6863d turn 5) 触发：合规 ad-hoc speaker 触发 rewrite
 * 后 rewriter 凭空补 \`<background scene="dark_s01" />\`——这种 rewrite 是 false
 * positive，本可以 skip。
 */
export function isActionableDegrade(d: DegradeEventV2): boolean {
  if (d.code === 'dialogue-adhoc-speaker') {
    return isForbiddenAdhocSuffix(d.detail);
  }
  if (d.code === 'container-truncated') {
    return false;
  }
  return true;
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

interface PublishBatchContext {
  readonly initialScene: SceneState;
  readonly publish: (event: Parameters<CoreEventSink['publish']>[0]) => void;
  readonly turnId: TurnId;
  /** Closure so the read happens at publish time, not at drain entry. */
  readonly getBatchId: () => string | null;
}

interface BatchTraceContext {
  readonly traceHandle: GenerateTraceHandle | undefined;
  readonly turn: number;
}

/**
 * 路线 A（2026-04-27）：跑一次 parser-v2 把整段 raw text 分析出 batches +
 * stats，**不**触发任何 core event / trace 副作用——纯函数。
 *
 * caller 用 stats（sentenceCount / degrades / looksBroken）决定 finalizeContent
 * 路径（rewrite only / 并行 rewrite+retry-main / skip），决定后再调
 * `playFinalNarrative` 把对应 analysis 的 batches 顺序 publish 给 sink。
 *
 * 同一段 text 在 main path 跑一次 + finalize 后可能再跑一次（rewrite 替换 text 时）。
 * parser-v2 是单调推进 + finalize 的 reducer，反复构造一次性实例没有副作用问题。
 */
function analyzeText(
  text: string,
  fromScene: SceneState,
  manifest: ParserManifest,
  turn: number,
): TextAnalysis {
  const parser = createParserV2({
    manifest,
    turnNumber: turn,
    startIndex: 0,
    initialScene: copyScene(fromScene),
  });
  const batches: NarrativeBatch[] = [];
  let scene = copyScene(fromScene);

  const collect = (batch: NarrativeBatch) => {
    if (
      batch.sentences.length === 0 &&
      batch.scratches.length === 0 &&
      batch.degrades.length === 0
    ) return;
    batches.push(batch);
    for (const s of batch.sentences) {
      if (s.kind !== 'scene_change') {
        scene = copyScene(s.sceneRef);
      }
    }
  };
  collect(parser.feed(text));
  collect(parser.finalize());

  let sentenceCount = 0;
  let scratchCount = 0;
  const degrades: DegradeEventV2[] = [];
  for (const batch of batches) {
    sentenceCount += batch.sentences.length;
    scratchCount += batch.scratches.length;
    if (batch.degrades.length > 0) degrades.push(...batch.degrades);
  }
  const looksBroken =
    sentenceCount === 0 ||
    degrades.length > 0 ||
    (scratchCount > 0 && sentenceCount === 0);

  return { batches, sentenceCount, scratchCount, degrades, looksBroken, finalScene: scene };
}

/**
 * Emit single-batch trace side effects (truncation events / ir-scratch /
 * ir-degrade)。跟 publishBatch 解耦——caller 决定 trace 何时发。
 */
function emitBatchTrace(batch: NarrativeBatch, ctx: BatchTraceContext): void {
  for (const sentence of batch.sentences) {
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
}

/**
 * Publish 一个 batch 的 `narrative-batch-emitted` core event + 推进 scene。
 * 返回 batch 处理后的新 scene，caller 用作下一次 publishBatch 的 initialScene。
 *
 * 不发 trace 事件（emitBatchTrace 单独处理）。
 */
function publishNarrativeBatch(
  batch: NarrativeBatch,
  ctx: PublishBatchContext,
): SceneState {
  let scene = ctx.initialScene;
  for (const sentence of batch.sentences) {
    if (sentence.kind !== 'scene_change') {
      scene = copyScene(sentence.sceneRef);
    }
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
  /**
   * turn 起始时的 scene 快照。路线 A 下：parser-v2 不在 main path 流式跑，
   * scene 在 main path 阶段不会推进；finalizeContent / playFinalNarrative 从
   * 这里出发分析 finalText、推进到本轮终态。
   */
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
  /**
   * S.1 streaming：onTextChunk 收到 chunk 时实时 feed parser-v2，让 batch 在
   * stream 期间立即 publish。null = 本轮不走 streaming（缺 parserManifest 时；
   * 当前 createGenerateTurnRuntime 强制 require parserManifest，所以实际不会 null，
   * 但保留 nullable 以便防御 / 未来 protocol 演进）。
   *
   * 跟 finalizeContent 决策耦合：streamingSentenceCount > 0 → 已经把 batches
   * publish 给 UI，跳过 rewriter / playFinalNarrative；
   * streamingSentenceCount === 0 → fall back 到 analyzeText + finalizeContent +
   * playFinalNarrative 的兜底路径，rewriter 仍可能救场。
   */
  private streamingParser: NarrativeParser | null = null;
  private streamingSentenceCount = 0;
  private streamingScratchCount = 0;
  private streamingDegrades: DegradeEventV2[] = [];

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
      const activePrepared = this.beginGenerateTurn(prepared);
      const result = await this.runLLMGenerate(
        activePrepared,
        traceHandle,
        toolCallStack,
        toolInputStack,
      );
      await this.completeGenerateTurn(activePrepared, result, traceHandle);
    } catch (error) {
      if (!this.deps.isActive()) {
        return this.snapshotResult(true);
      }
      this.failGenerateTurn(error, traceHandle);
    } finally {
      this.currentStepBatchId = null;
      this.currentStepId = null;
      this.abortController = null;
      // S.1：streamingParser 在 completeGenerateTurn 已置 null，这里给错误 / abort
      // 路径兜底（completeGenerateTurn 抛异常 / runtime crash 时仍然清理）。
      this.streamingParser = null;
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

  private beginGenerateTurn(prepared: GenerateTurnPrepared): GenerateTurnPrepared {
    this.abortController = new AbortController();
    this.currentNarrativeBuffer = '';
    this.currentReasoningBuffer = '';
    this.currentTurnRawText = '';
    this.rewriteAppliedThisTurn = false;
    // turn 起始 scene 留作 analyzeText / playFinalNarrative 的回滚锚点。
    // S.1 后：scene 在 streaming pass 中会被 processStreamingBatch 推进；
    // 但如果 streaming 一个 sentence 都没产出（fallback 路径），currentScene
    // 不会被推进，仍等于 turnInitialScene，让 playFinalNarrative 从这里 replay。
    this.turnInitialScene = copyScene(this.currentScene);
    // S.1：创建跨 chunk 的 streaming parser 实例，turnInitialScene 作为初始 scene。
    if (this.deps.parserManifest) {
      this.streamingParser = createParserV2({
        manifest: this.deps.parserManifest,
        turnNumber: this.deps.turn,
        startIndex: 0,
        initialScene: copyScene(this.turnInitialScene),
      });
    } else {
      this.streamingParser = null;
    }
    this.streamingSentenceCount = 0;
    this.streamingScratchCount = 0;
    this.streamingDegrades = [];
    this.publish({ type: 'assistant-message-started', turnId: this.turnId });
    return prepared;
  }

  private async runLLMGenerate(
    prepared: GenerateTurnPrepared,
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
        // S.1：流式 feed parser-v2，把 chunk 解析出的 batches 立即 publish 给
        // sink。玩家在 step-1 长 narration（典型 19s 流出 774 tokens）期间就能
        // 看到 sentences 增量到达，而不是等到 completeGenerateTurn。
        // 注意：tag 跨 chunk 边界劈开是 OK 的——htmlparser2 内部维护 streaming
        // buffer，open/close tag event 只在完整 tag 拼齐后才触发。
        if (this.streamingParser) {
          const batch = this.streamingParser.feed(chunk);
          this.processStreamingBatch(batch, traceHandle);
        }
        // assistant-text-delta 仍发——EditorDebugPanel 流式预览要用。
        this.publish({
          type: 'assistant-text-delta',
          turnId: this.turnId,
          stepId: this.currentStepId,
          batchId: toBatchId(this.currentStepBatchId),
          text: chunk,
        });
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

  /**
   * S.1 streaming：onTextChunk 喂出来的 batch 立即处理——发 trace 事件、
   * publish narrative-batch-emitted、推进 currentScene、累计统计。
   *
   * 跟 playFinalNarrative 走的是同一对 helper（emitBatchTrace +
   * publishNarrativeBatch），保证 streaming pass 跟 fallback replay 的事件序列
   * 形态完全一致——下游消费方（recording / WS / persistence）不需要区分两种
   * 来源。
   */
  private processStreamingBatch(
    batch: NarrativeBatch,
    traceHandle: GenerateTraceHandle | undefined,
  ): void {
    if (
      batch.sentences.length === 0 &&
      batch.scratches.length === 0 &&
      batch.degrades.length === 0
    ) return;

    emitBatchTrace(batch, { traceHandle, turn: this.deps.turn });

    const sceneAfter = publishNarrativeBatch(batch, {
      initialScene: this.currentScene,
      publish: (event) => this.publish(event),
      turnId: this.turnId,
      getBatchId: () => this.currentStepBatchId,
    });
    this.currentScene = sceneAfter;

    this.streamingSentenceCount += batch.sentences.length;
    this.streamingScratchCount += batch.scratches.length;
    if (batch.degrades.length > 0) {
      this.streamingDegrades = [...this.streamingDegrades, ...batch.degrades];
    }
  }

  private async completeGenerateTurn(
    prepared: GenerateTurnPrepared,
    result: GenerateResult,
    traceHandle: GenerateTraceHandle | undefined,
  ): Promise<void> {
    // assistant streaming 关闭信号（onTextChunk 阶段不再有更新）
    this.publish({
      type: 'assistant-message-finalized',
      turnId: this.turnId,
      finishReason: result.finishReason,
    });

    // S.1：drain streaming parser 尾批——处理流末未闭合的容器（truncated:true）。
    if (this.streamingParser) {
      const tail = this.streamingParser.finalize();
      this.processStreamingBatch(tail, traceHandle);
      this.streamingParser = null;
    }

    if (this.streamingSentenceCount > 0) {
      // S.1 主路径：streaming pass 已经 publish 了所有 batches，跳过 rewriter
      // / playFinalNarrative。rewriter 只在 streaming sentenceCount === 0 时
      // 救场（保留原 fallback 行为）。
      //
      // 与原 finalizeContent 决策矩阵对比：
      //  - 原 path A（sentenceCount>0 + 仅 non-actionable degrade）：skip → 等价
      //  - 原 path B（sentenceCount>0 + actionable degrade）：rewrite-only —
      //    新行为下也跳过；trade-off 是已 publish 的 sentences 不再被 rewriter
      //    cosmetic 修正（典型修正：剥 zh-CN 内联 tag、删 hear="__npc__空气"
      //    属性、补 truncated container）—— parser-v2 自身已经 robustness 处理
      //    了大多数这些场景，rewriter 改动玩家几乎察觉不到。详见
      //    docs/html-data-attr-protocol-proposal.md 关于 protocol-noise 的讨论。
      const looksBrokenStreamed =
        this.streamingDegrades.length > 0 ||
        (this.streamingScratchCount > 0 && this.streamingSentenceCount === 0);
      this.publish({
        type: 'rewrite-attempted',
        turnId: this.turnId,
        rawTextLength: this.currentTurnRawText.length,
        looksBroken: looksBrokenStreamed,
      });
      this.publish({
        type: 'rewrite-completed',
        turnId: this.turnId,
        status: 'skipped-streamed',
        fallbackReason: null,
        attempts: 0,
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        model: null,
        outputTextLength: this.currentTurnRawText.length,
        verifiedSentenceCount: this.streamingSentenceCount,
        applied: false,
      });
    } else {
      // S.1 fallback：streaming pass 一个 sentence 都没产出——可能是 GM 输出
      // 完全无效（parser-v2 抽不出任何 narration / dialogue），或 raw 全是
      // scratch / 装饰性内容。这种 case 跑原 finalizeContent 路径，让 rewriter
      // / retry-main 兜底。currentScene 在 streaming pass 没被推进过（无 sentence
      // 推进），仍等于 turnInitialScene，playFinalNarrative 从这里 replay。
      const rawAnalysis = this.deps.parserManifest
        ? analyzeText(
            this.currentTurnRawText,
            this.turnInitialScene,
            this.deps.parserManifest,
            this.deps.turn,
          )
        : null;

      const { finalText, finalAnalysis } = await this.finalizeContent(
        rawAnalysis,
        prepared,
        traceHandle,
      );

      // 防止 scratch-only batches 双发：如果 finalText 仍等于 rawText（rewrite /
      // retry-main 都没救成功，fallback 回 raw），streaming pass 已经把那些
      // scratch / degrade 批 publish 过了，别再 playFinalNarrative replay 一遍。
      // 只有 finalText 是新内容（rewrite / retry-main 救场成功）才需要 replay。
      if (finalText !== this.currentTurnRawText) {
        this.playFinalNarrative(finalText, finalAnalysis, traceHandle);
      }
    }

    await this.persistGenerateResult(result);
    await this.compactMemoryIfNeeded();
    await this.syncGenerateDebugState();
    traceHandle?.end({ text: result.text, finishReason: result.finishReason });
  }

  /**
   * 路线 A 协调器：根据 raw analysis 决定 finalText + 对应 analysis。
   *
   * 决策矩阵（全部前提：rawText 非空 + parserManifest 配置 + rewriter 配置）：
   *
   *   A. sentenceCount > 0 + 仅 non-actionable degrade → **skip**：finalText=raw, finalAnalysis=raw
   *   B. sentenceCount > 0 + actionable degrade → **rewrite only**：rewrite ok → 用 rewrite，否则 fallback
   *   C. sentenceCount === 0 + retryMain 配置 → **并行 rewrite + retry-main**：
   *        - rewrite 救得了（verifiedSentenceCount > 0）→ 用 rewrite
   *        - rewrite 救不了 + retry-main verifiedSentenceCount > 0 → 用 retry-main 输出过一次 rewrite
   *        - 都救不了 → fallback raw（玩家本轮看到空，但至少 UI 不卡）
   *   D. sentenceCount === 0 + 没配 retryMain → 退化到 rewrite only
   *   E. raw 空白 / parserManifest 缺失 / rewriter 缺失 → finalText=raw, finalAnalysis=raw
   *
   * 标记 `rewriteAppliedThisTurn = true` 当且仅当 finalText 替换了 raw（B 路径
   * rewrite 成功 / C 路径任一救场成功）—— persistGenerateResult 据此选 reason。
   */
  private async finalizeContent(
    rawAnalysis: TextAnalysis | null,
    prepared: GenerateTurnPrepared,
    traceHandle: GenerateTraceHandle | undefined,
  ): Promise<{ finalText: string; finalAnalysis: TextAnalysis | null }> {
    const rawText = this.currentTurnRawText;
    const rewriter = this.deps.rewriter;
    const parserManifest = this.deps.parserManifest;

    // E. 提早返回：缺少必要依赖 / raw 空白
    if (!rewriter || !parserManifest || !rawAnalysis || rawText.trim().length === 0) {
      return { finalText: rawText, finalAnalysis: rawAnalysis };
    }

    // A. skip：sentenceCount>0 + 仅 non-actionable degrade
    const hasActionableProblem =
      rawAnalysis.sentenceCount === 0 ||
      rawAnalysis.degrades.some(isActionableDegrade);
    if (!hasActionableProblem) {
      this.publish({
        type: 'rewrite-attempted',
        turnId: this.turnId,
        rawTextLength: rawText.length,
        looksBroken: rawAnalysis.looksBroken,
      });
      this.publish({
        type: 'rewrite-completed',
        turnId: this.turnId,
        status: 'skipped-non-actionable',
        fallbackReason: null,
        attempts: 0,
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        model: null,
        outputTextLength: rawText.length,
        verifiedSentenceCount: null,
        applied: false,
      });
      return { finalText: rawText, finalAnalysis: rawAnalysis };
    }

    // C. sentenceCount === 0 → 并行 rewrite + retry-main（如 retryMain 注入）
    if (rawAnalysis.sentenceCount === 0 && this.deps.retryMain) {
      return await this.runParallelRewriteAndRetryMain(
        rawText,
        rawAnalysis,
        prepared,
        traceHandle,
      );
    }

    // B (sentenceCount>0+actionable) / D (sentenceCount=0 但没配 retryMain)：
    // rewrite only 路径
    const rewriteResult = await this.runRewrite(rawText, rawAnalysis, traceHandle);
    return this.applyRewriteOnlyResult(rewriteResult, rawText, rawAnalysis, parserManifest);
  }

  /**
   * 路线 A：sentenceCount===0 时并行触发 rewrite + retry-main，按优先级取结果。
   *
   * 优先级：rewrite 救场 > retry-main 救场 > raw fallback。retry-main 输出
   * 还要再过一次 rewrite 保证格式（GM persona 输出格式合规率不是 100%）。
   *
   * trace 视角：
   * - rewrite-attempted/completed 走原 rewrite path，记录 rewrite 决策
   * - retry-main-attempted/completed 单独 emit，adopted=true 仅当最终 finalText
   *   是从 retry-main 链来的
   */
  private async runParallelRewriteAndRetryMain(
    rawText: string,
    rawAnalysis: TextAnalysis,
    prepared: GenerateTurnPrepared,
    traceHandle: GenerateTraceHandle | undefined,
  ): Promise<{ finalText: string; finalAnalysis: TextAnalysis | null }> {
    const parserManifest = this.deps.parserManifest!;

    this.publish({
      type: 'rewrite-attempted',
      turnId: this.turnId,
      rawTextLength: rawText.length,
      looksBroken: rawAnalysis.looksBroken,
    });
    this.publish({
      type: 'retry-main-attempted',
      turnId: this.turnId,
      rawTextLength: rawText.length,
      mainPathMessageCount: prepared.context.messages.length,
    });

    // 并行：max(rewrite, retry-main) latency 而不是串行 sum
    const [rewriteResult, retryMainResult] = await Promise.all([
      this.invokeRewrite(rawText, rawAnalysis, traceHandle),
      this.invokeRetryMain(rawText, prepared, traceHandle),
    ]);

    // rewrite 是否救场？status='ok' 说明 verifyParse 通过 (sentenceCount>0)
    if (rewriteResult.status === 'ok' && rewriteResult.text !== rawText) {
      this.emitRewriteCompletedEvent(rewriteResult, true);
      this.emitRetryMainCompletedEvent(retryMainResult, false);
      this.rewriteAppliedThisTurn = true;
      const finalAnalysis = analyzeText(
        rewriteResult.text,
        this.turnInitialScene,
        parserManifest,
        this.deps.turn,
      );
      return { finalText: rewriteResult.text, finalAnalysis };
    }

    // rewrite 救不了 → retry-main 输出再过一次 rewrite（如 retry-main 救出正文）
    if (retryMainResult.status === 'ok' && retryMainResult.text.trim().length > 0) {
      this.emitRewriteCompletedEvent(rewriteResult, false);
      // 二次 rewrite：retry-main 输出可能仍有格式问题
      const retryAnalysis = analyzeText(
        retryMainResult.text,
        this.turnInitialScene,
        parserManifest,
        this.deps.turn,
      );
      const secondRewrite = await this.invokeRewrite(
        retryMainResult.text,
        retryAnalysis,
        traceHandle,
      );
      // 决定最终：二次 rewrite ok → 用它；否则用 retry-main 原文
      if (secondRewrite.status === 'ok' && secondRewrite.text !== retryMainResult.text) {
        // 二次 rewrite 也走 rewrite-completed event 流（让 trace 看到链路），
        // 但 applied=true 标记最终用二次 rewrite 输出
        this.emitRewriteCompletedEvent(secondRewrite, true);
        this.emitRetryMainCompletedEvent(retryMainResult, true);
        this.rewriteAppliedThisTurn = true;
        const finalAnalysis = analyzeText(
          secondRewrite.text,
          this.turnInitialScene,
          parserManifest,
          this.deps.turn,
        );
        return { finalText: secondRewrite.text, finalAnalysis };
      }
      // 二次 rewrite 失败：直接用 retry-main 原文
      this.emitRewriteCompletedEvent(secondRewrite, false);
      this.emitRetryMainCompletedEvent(retryMainResult, true);
      this.rewriteAppliedThisTurn = true;
      return { finalText: retryMainResult.text, finalAnalysis: retryAnalysis };
    }

    // 都救不了：fallback raw（玩家本轮看到空，但 UI 不卡）
    this.emitRewriteCompletedEvent(rewriteResult, false);
    this.emitRetryMainCompletedEvent(retryMainResult, false);
    return { finalText: rawText, finalAnalysis: rawAnalysis };
  }

  /**
   * Rewrite-only 路径（B / D）：跑一次 rewrite，emit completed event，
   * 决定 finalText。
   */
  private async runRewrite(
    rawText: string,
    rawAnalysis: TextAnalysis,
    traceHandle: GenerateTraceHandle | undefined,
  ): Promise<RewriteResult> {
    this.publish({
      type: 'rewrite-attempted',
      turnId: this.turnId,
      rawTextLength: rawText.length,
      looksBroken: rawAnalysis.looksBroken,
    });
    return await this.invokeRewrite(rawText, rawAnalysis, traceHandle);
  }

  private applyRewriteOnlyResult(
    rewriteResult: RewriteResult,
    rawText: string,
    rawAnalysis: TextAnalysis,
    parserManifest: ParserManifest,
  ): { finalText: string; finalAnalysis: TextAnalysis | null } {
    const applied =
      rewriteResult.status === 'ok' &&
      rewriteResult.text.trim().length > 0 &&
      rewriteResult.text !== rawText;
    this.emitRewriteCompletedEvent(rewriteResult, applied);
    if (applied) {
      this.rewriteAppliedThisTurn = true;
      const finalAnalysis = analyzeText(
        rewriteResult.text,
        this.turnInitialScene,
        parserManifest,
        this.deps.turn,
      );
      return { finalText: rewriteResult.text, finalAnalysis };
    }
    return { finalText: rawText, finalAnalysis: rawAnalysis };
  }

  private emitRewriteCompletedEvent(result: RewriteResult, applied: boolean): void {
    this.publish({
      type: 'rewrite-completed',
      turnId: this.turnId,
      status: result.status,
      fallbackReason: result.fallbackReason,
      attempts: result.attempts,
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      model: result.model,
      outputTextLength: result.text.length,
      verifiedSentenceCount: result.verified?.sentenceCount ?? null,
      applied,
    });
  }

  private emitRetryMainCompletedEvent(result: RetryMainResult, adopted: boolean): void {
    this.publish({
      type: 'retry-main-completed',
      turnId: this.turnId,
      status: result.status,
      fallbackReason: result.fallbackReason,
      attempts: result.attempts,
      latencyMs: result.latencyMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      model: result.model,
      outputTextLength: result.text.length,
      verifiedSentenceCount: result.verified?.sentenceCount ?? null,
      adopted,
    });
  }

  private async invokeRewrite(
    rawText: string,
    rawAnalysis: TextAnalysis,
    traceHandle: GenerateTraceHandle | undefined,
  ): Promise<RewriteResult> {
    const parserManifest = this.deps.parserManifest!;
    const invoke = this.deps.rewriter!;
    return await rewriteNarrative(
      {
        rawText,
        parserView: {
          sentences: [],
          scratchCount: rawAnalysis.scratchCount,
          degrades: rawAnalysis.degrades,
          looksBroken: rawAnalysis.looksBroken,
        },
        manifest: summarizeManifest(parserManifest),
        turn: this.deps.turn,
        abortSignal: this.abortController?.signal,
      },
      {
        invoke,
        verifyParse: (text) => verifyParseWithParserV2(text, parserManifest),
        parserManifest,
        maxRetries: 1,
        trace: traceHandle
          ? {
              start: (input) => {
                const span = traceHandle.startNestedGeneration({
                  name: 'narrative-rewrite',
                  input: { system: input.systemPrompt, user: input.userMessage },
                  metadata: { turn: this.deps.turn, looksBroken: rawAnalysis.looksBroken },
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
  }

  private async invokeRetryMain(
    rawText: string,
    prepared: GenerateTurnPrepared,
    traceHandle: GenerateTraceHandle | undefined,
  ): Promise<RetryMainResult> {
    const parserManifest = this.deps.parserManifest!;
    const invoke = this.deps.retryMain!;
    return await retryMainNarrative(
      {
        rawText,
        mainPathSystemPrompt: prepared.context.systemPrompt,
        mainPathMessages: prepared.context.messages as ReadonlyArray<ModelMessage>,
        turn: this.deps.turn,
        abortSignal: this.abortController?.signal,
      },
      {
        invoke,
        verifyParse: (text) => verifyParseWithParserV2(text, parserManifest),
        parserManifest,
        maxRetries: 0,
        trace: traceHandle
          ? {
              start: (input) => {
                const span = traceHandle.startNestedGeneration({
                  name: 'narrative-retry-main',
                  input: {
                    system: input.systemPrompt,
                    user: `(messages: ${input.messageCount}, raw: ${input.rawTextLength} chars)`,
                  },
                  metadata: { turn: this.deps.turn },
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
  }

  /**
   * 路线 A：finalizeContent 决策完成后，把 finalText 对应的 batches 顺序
   * publish 给 sink（UI / recording / etc）。
   *
   * Main path 全程 deferred 没 publish 任何 batch，所以这里**不需要** emit
   * narrative-turn-reset——直接 publish 完整 batch 序列就是 UI 第一次看到
   * 这一 turn 的 sentence。
   *
   * - 当 finalAnalysis 没东西（rawText 全空 / 没 manifest）→ 不 publish，留给
   *   persistGenerateResult 直接落 buffer
   * - 当 rewriteAppliedThisTurn=true → 覆盖 currentNarrativeBuffer = finalText
   *   （persistGenerateResult 用此值落 reason='rewrite-applied'，messages-builder
   *   投影时跳过同 turn 其他 segment）
   * - 当 rewriteAppliedThisTurn=false → 保留 currentNarrativeBuffer 的 raw
   *   remainder（被 preflush 切走的部分以 reason='signal-input-preflush' 已经落库；
   *   剩余以 reason='generate-complete' 落库；messages-builder 拼起来 = 完整 raw）
   */
  private playFinalNarrative(
    finalText: string,
    finalAnalysis: TextAnalysis | null,
    traceHandle: GenerateTraceHandle | undefined,
  ): void {
    if (!finalAnalysis || finalText.length === 0) {
      // 没东西可 publish。currentScene 不动（保持 turnInitialScene）。
      if (this.rewriteAppliedThisTurn) {
        this.currentNarrativeBuffer = finalText;
      }
      return;
    }

    // 路线 A：scene 在 main path 阶段没推进过（onTextChunk 不调 parser），所以
    // currentScene 应该还是 turnInitialScene。这里显式回到 initialScene 让代码
    // 意图清晰，也防御 future 改动可能误推 scene。
    this.currentScene = copyScene(this.turnInitialScene);

    const traceCtx: BatchTraceContext = { traceHandle, turn: this.deps.turn };
    const publishCtx: PublishBatchContext = {
      initialScene: this.currentScene,
      publish: (event) => this.publish(event),
      turnId: this.turnId,
      getBatchId: () => this.currentStepBatchId,
    };

    for (const batch of finalAnalysis.batches) {
      emitBatchTrace(batch, traceCtx);
      this.currentScene = publishNarrativeBatch(batch, {
        ...publishCtx,
        initialScene: this.currentScene,
      });
    }

    // 重新统计 instance counters 以反映 finalText（rawAnalysis 的统计已经先存
    // 进 instance 给 trace 用，这里不要再加）—— rewrite/retry 决策已结束，
    // 后续任何 bug 关心 final 状态就读 finalAnalysis。

    if (this.rewriteAppliedThisTurn) {
      this.currentNarrativeBuffer = finalText;
    }
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
