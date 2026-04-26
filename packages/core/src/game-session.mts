/**
 * GameSession — 端到端集成层
 *
 * 串联所有核心模块：
 *   StateStore, MemoryManager, ContextAssembler, ToolExecutor, LLMClient
 *
 * 通过 CoreEvent 输出运行时事件，再投影到 SessionEmitter / WebSocket 等端口。
 * 这使得 GameSession 可以被浏览器、后端服务、事件日志或离线评测任务消费。
 *
 * 核心循环：Generate + Receive
 *   1. Generate: 组装 context → 调用 LLM（agentic tool loop）→ 追加记忆 → 按需压缩
 *      - signal_input_needed 使用 turn-bounded record-only 模式，generate 返回后再等玩家输入
 *      - 一次 generate() 内只记录待处理输入请求，不直接消费玩家输入
 *   2. Receive: LLM 自然停止后，等待玩家输入（fallback，不经过 signal_input_needed）
 *   循环直到 session 被停止
 *
 * 对外只暴露简单的 API：
 *   - start(config): 初始化并开始运行
 *   - submitInput(text): 提交玩家输入
 *   - stop(): 停止
 */

import type {
  BackgroundAsset,
  CharacterAsset,
  PromptSegment,
  ProtocolVersion,
  SceneState,
} from '#internal/types';
import { StateStore } from '#internal/state-store';
import type { Memory } from '#internal/memory/types';
import { createMemory } from '#internal/memory/factory';
import { wrapMemoryWithRetrievalLogger } from '#internal/memory/retrieval-logger';
import { estimateTokens } from '#internal/tokens';
import { computeFocus } from '#internal/focus';
import { LLMClient } from '#internal/llm-client';
import type { LLMConfig } from '#internal/llm-client';
import type { ParserManifest } from '#internal/narrative-parser-v2';
import {
  CURRENT_PROTOCOL_VERSION,
  resolveRuntimeProtocolVersion,
} from '#internal/protocol-version';
import { computeReceivePayload } from '#internal/game-session/input-payload';
import type {
  BatchId,
  CoreEvent,
  CoreEventSink,
  SessionSnapshot,
} from '#internal/game-session/core-events';
import {
  batchId as toBatchId,
  createDurableFirstCoreEventSink,
  createInputRequest,
  inputRequestId as toInputRequestId,
  turnId as toTurnId,
} from '#internal/game-session/core-events';
import {
  createSessionPersistenceCoreEventSink,
  isSessionPersistenceCoreEvent,
} from '#internal/game-session/persistence-core-event-sink';
import {
  createGenerateTurnRuntime,
  type GenerateTurnPendingSignal,
  type GenerateTurnRuntime,
} from '#internal/game-session/generate-turn-runtime';
import type {
  GameSessionConfig,
  RestoreConfig,
  SessionTracing,
} from '#internal/game-session/types';

export {
  NARRATION_HARD_LIMIT,
  NARRATION_SOFT_LIMIT,
  createNarrationAccumulator,
  findNarrationCut,
} from '#internal/game-session/narration';
export { computeReceivePayload } from '#internal/game-session/input-payload';
export { applyScenePatchToState } from '#internal/game-session/scene-state';
export { createRecordingSessionEmitter } from '#internal/game-session/recording-emitter';
export type { RecordedSessionOutput, RecordingSessionEmitter } from '#internal/game-session/recording-emitter';
export { createRecordingSessionOutputSink } from '#internal/game-session/recording-session-output';
export type { RecordingSessionOutputSink } from '#internal/game-session/recording-session-output';
export * from '#internal/game-session/core-events';
export { validateCoreEventSequence } from '#internal/game-session/core-event-protocol';
export {
  deriveCoreEventLogRestoreState,
  deriveCoreEventRestoreState,
} from '#internal/game-session/core-event-log-restore';
export {
  buildMessagesFromCoreEventHistory,
  capMessagesByBudgetFromTail,
  coreEventHistoryFromEnvelopes,
  projectCoreEventHistoryPage,
  projectCoreEventHistoryToMemoryEntries,
  projectCoreEventHistoryToSentences,
  serializeMessagesForDebug,
} from '#internal/game-session/core-event-history';
export type {
  BuildCoreEventMessagesOptions,
  CoreEventHistoryItem,
  CoreEventHistoryReader,
  CoreEventMemoryEntry,
  CoreEventSentencePage,
} from '#internal/game-session/core-event-history';
export type {
  CoreEventLogRestoreOptions,
  CoreEventLogRestoreState,
  CoreEventLogRestoreStatus,
} from '#internal/game-session/core-event-log-restore';
export {
  createCoreEventLogSink,
  replayCoreEventEnvelopes,
} from '#internal/game-session/event-log-core-event-sink';
export type {
  CoreEventLogSink,
  CoreEventLogSinkOptions,
  CoreEventLogWriter,
  CoreEventReplayOptions,
} from '#internal/game-session/event-log-core-event-sink';
export {
  createSessionPersistenceCoreEventSink,
  isSessionPersistenceCoreEvent,
} from '#internal/game-session/persistence-core-event-sink';
export type { SessionPersistenceCoreEventSink } from '#internal/game-session/persistence-core-event-sink';
export { createRecordingCoreEventSink } from '#internal/game-session/recording-core-events';
export type {
  GameSessionConfig,
  GenerateTraceHandle,
  NestedGenerationTraceHandle,
  RestoreConfig,
  SessionPersistence,
  SessionTracing,
  ToolCallTraceHandle,
} from '#internal/game-session/types';
export type { ProtocolVersion } from '#internal/types';

// ============================================================================
// GameSession
// ============================================================================

export class GameSession {
  private stateStore!: StateStore;
  private memory!: Memory;

  /**
   * 最近一次玩家输入 —— 作为 Memory.retrieve 的 default query 来源。
   *
   * 由 submitInput 写入，在下一次 assembleContext 时被 buildRetrievalQuery 读。
   * 挂起路径（signal_input_needed）的玩家输入也走 submitInput，所以统一捕获。
   */
  private lastPlayerInput: string = '';
  private llmClient!: LLMClient;
  private segments!: PromptSegment[];
  private enabledTools!: string[];
  private tokenBudget!: number;
  private initialPrompt?: string;
  private assemblyOrder?: string[];
  private disabledSections?: string[];
  private tracing?: SessionTracing;
  private coreEventSink?: CoreEventSink;
  // Session lifecycle
  private active = false;

  /**
   * LLM 本轮 generate 里调用了 end_scenario？
   * coreLoop 在 Generate 阶段结束后检查此 flag：true → 持久化结束 +
   * 退出循环，不再进入下一个 Receive 阶段（即不再接受玩家输入）。
   * 每轮 generate 开始时不清零——一旦置 true 就锁死到 session 结束。
   */
  private scenarioEnded = false;
  private scenarioEndReason: string | undefined;

  /**
   * VN 当前场景快照（M3）。
   * 当前运行路径：由声明式 parser 每条 Sentence 的 sceneRef 更新。
   * legacy v1 工具切景只保留历史读取/迁移兼容，新的 runtime 不再执行。
   * start() 时从 manifest.defaultScene 或 {background:null, sprites:[]} 初始化，
   * restore() 时从 DB 恢复。每次变化在 generate 结束后持久化。
   */
  private currentScene: SceneState = {
    background: null,
    sprites: [],
  };

  /**
   * 视觉 IR 协议版本。缺省使用当前声明式视觉协议。
   * v1-tool-call 只保留历史读取/迁移兼容，runtime 不再执行。
   */
  private protocolVersion: ProtocolVersion = CURRENT_PROTOCOL_VERSION;
  private parserManifest?: ParserManifest;
  private characters: ReadonlyArray<CharacterAsset> = [];
  private backgrounds: ReadonlyArray<BackgroundAsset> = [];

  // 外循环 Receive 阶段的挂起 Promise（等玩家输入，signal / natural stop / maxSteps 共用）
  private inputResolve: ((text: string) => void) | null = null;

  /**
   * 当前等玩家输入的 signal（方案 B / 2026-04-23 turn-bounded）。
   *
   * 生命周期：
   *   - GenerateTurnRuntime 在 signal_input_needed.execute 回调时设置
   *   - generate() 因 stopWhen hit 而返回后，coreLoop 的 Receive 阶段读它决定输入模式
   *   - 玩家输入提交、写完 player_input entry 后清回 null
   *
   * null 表示"当前回合没有 signal（LLM 自然停止 / maxSteps / restore 后新一轮）"，
   * 此时 Receive 阶段走 freetext 路径。
   */
  private pendingSignal: GenerateTurnPendingSignal | null = null;

  // 当前 generate 回合的 turn-scoped runtime，用于 stop() 中断 LLM stream。
  private activeGenerateTurn: GenerateTurnRuntime | null = null;

  // compressFn 从 game-session 移除 —— 现在由 Memory adapter 构造时注入
  // （Legacy 用 truncatingCompressFn，LLMSummarizer 用真 LLM）

  /** 即时更新 LLM 配置（下一次 generate 生效，无需重启会话） */
  updateLLMConfig(patch: Partial<LLMConfig>): void {
    this.llmClient?.updateConfig(patch);
  }

  /** Initialize and start the game session */
  async start(config: GameSessionConfig): Promise<void> {
    let initialized = false;
    try {
      await this.initializeCore(config);
      initialized = true;

      // inheritedSummary 已从架构里移除：章节不再是 memory 生命周期事件。

      // M3: 初始化 currentScene —— 用剧本 defaultScene，否则空
      this.currentScene = config.defaultScene ?? { background: null, sprites: [] };

      await this.publishDurableCoreEvent({
        type: 'session-started',
        snapshot: await this.createSessionSnapshot(),
      });

      // Start core loop
      this.active = true;
      await this.coreLoop();
    } catch (error) {
      if (!initialized || this.active) {
        this.publishCoreEvent({
          type: 'session-error',
          phase: 'start',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * 从持久化快照恢复会话（跳过 start() 的初始化，直接进入对应阶段）
   *
   * 恢复策略：
   *   - waiting-input → 直接进入 Receive Phase（等玩家输入）
   *   - generating → 视为上一轮未完成，进入 Receive Phase
   *   - idle → 等玩家触发，进入完整 coreLoop
   */
  async restore(config: RestoreConfig): Promise<void> {
    let initialized = false;
    try {
      await this.initializeCore(config);
      initialized = true;

      // 注入持久化快照
      this.stateStore.restore(config.stateVars, config.turn);
      // memorySnapshot 是 DB 里 opaque JSON，由 adapter 的 restore 自解释。
      // null 表示初次游玩（无历史），LegacyMemory.restore 对 undefined entries/summaries 兜底为空。
      if (config.memorySnapshot) {
        await this.memory.restore(config.memorySnapshot);
      }

      // M3: 恢复 currentScene —— 优先 DB 快照，其次 manifest 默认，最后空
      this.currentScene =
        config.currentScene ??
        config.defaultScene ??
        { background: null, sprites: [] };

      await this.publishDurableCoreEvent({
        type: 'session-restored',
        restoredFrom: normalizeRestoredFrom(config.status),
        snapshot: await this.createSessionSnapshot(),
      });

      // 可观测性：恢复标记，方便 Langfuse UI 中识别"断点"
      this.tracing?.markSessionRestored(config.turn, {
        status: config.status,
        hasSnapshot: config.memorySnapshot !== null,
      });

      this.active = true;

      // 如果这个 playthrough 已经结束了，直接进入 finished 状态不再启动循环。
      // 消费端会看到只读的叙事历史。
      if (config.status === 'finished') {
        this.active = false;
        return;
      }

      // 根据恢复时的状态决定进入点
      if (config.status === 'waiting-input') {
        await this.publishDurableCoreEvent({
          type: 'waiting-input-started',
          turnId: toTurnId(config.turn),
          requestId: toInputRequestId(config.turn),
          source: 'restore',
          causedByBatchId: null,
          request: createInputRequest(
            config.inputHint ?? null,
            config.inputType === 'choice' ? config.choices ?? null : null,
          ),
          snapshot: await this.createSessionSnapshot(),
        });

        // 等玩家输入，然后进入 coreLoop
        const inputText = await this.waitForInput();
        if (!this.active) return;

        if (inputText) {
          // restore 路径下玩家刚从 DB 恢复的 choices 里选 → 算 selectedIndex
          const payload = computeReceivePayload(inputText, config.choices ?? null);
          await this.memory.appendTurn({
            turn: config.turn,
            role: 'receive',
            content: inputText,
            tokenCount: estimateTokens(inputText),
          });
          const memSnap = await this.memory.snapshot();
          const receiveBatchId = crypto.randomUUID() as BatchId;
          await this.publishDurableCoreEvent({
            type: 'player-input-recorded',
            turnId: toTurnId(config.turn),
            requestId: toInputRequestId(config.turn),
            batchId: receiveBatchId,
            text: inputText,
            payload,
            sentence: {
              kind: 'player_input',
              text: inputText,
              ...(payload.selectedIndex !== undefined ? { selectedIndex: payload.selectedIndex } : {}),
              sceneRef: copyScene(this.currentScene),
              turnNumber: config.turn,
              index: Date.now(),
            },
            snapshot: {
              turn: config.turn,
              stateVars: this.stateStore.getAll(),
              memorySnapshot: memSnap,
              currentScene: copyScene(this.currentScene),
            },
          });
        }

        // 继续正常 coreLoop
        await this.coreLoop();
      } else {
        // idle 或 generating → 从头开始 coreLoop
        await this.coreLoop();
      }
    } catch (error) {
      if (!initialized || this.active) {
        this.publishCoreEvent({
          type: 'session-error',
          phase: 'restore',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Submit player input —— 方案 B（turn-bounded）下只有一条路径：
   * 外循环 Receive 阶段正在 `waitForInput()` 挂起，resolve 它让 coreLoop 继续。
   * coreLoop 内部根据 `this.pendingSignal` 走 signal 或 freetext 处理。
   *
   * 老的挂起模式（signalInputResolve）已删除。
   */
  async submitInput(text: string): Promise<void> {
    // 捕获本次 player input 作为下一次 Memory.retrieve 的 default query
    this.lastPlayerInput = text;

    if (this.inputResolve) {
      const resolve = this.inputResolve;
      this.inputResolve = null;
      resolve(text);
    }
  }

  /** Stop the session */
  stop(): void {
    this.active = false;

    // 中断进行中的 generate()
    this.activeGenerateTurn?.abort();
    this.activeGenerateTurn = null;

    // resolve 外循环的 waitForInput（防挂死）；方案 B 下没有 signalInputResolve 了
    if (this.inputResolve) {
      this.inputResolve('');
      this.inputResolve = null;
    }

    this.publishCoreEvent({ type: 'session-stopped', reason: 'user' });
  }

  private async initializeCore(config: GameSessionConfig | RestoreConfig): Promise<void> {
    this.stateStore = new StateStore(config.stateSchema);
    // LLMClient 先于 Memory 创建 —— llm-summarizer adapter 构造时要注入 llmClient。
    this.llmClient = new LLMClient(config.llmConfig);
    this.memory = await createMemory({
      scope: {
        playthroughId: config.playthroughId,
        userId: config.userId,
        chapterId: config.chapterId,
      },
      config: config.memoryConfig,
      llmClient: this.llmClient,
      mem0ApiKey: config.mem0ApiKey,
      memoraxConfig: config.memoraxConfig,
      coreEventReader: config.coreEventReader,
      // ANN.1：删除过滤器透传给 adapter，retrieve 时过滤被标 entries
      deletionFilter: config.memoryDeletionFilter,
    });
    // ANN.1：包一层 retrieval logger，每次 retrieve 后 fire-and-forget 落库 + 广播。
    // batchId 在 context-assembly 阶段（retrieve 唯一 callsite）尚未分配，固定 null。
    if (config.memoryRetrievalLogger) {
      this.memory = wrapMemoryWithRetrievalLogger(this.memory, {
        logger: config.memoryRetrievalLogger,
        getTurn: () => this.stateStore.getTurn(),
        getBatchId: () => null,
      });
    }
    this.segments = config.segments;
    this.enabledTools = config.enabledTools ?? [];
    this.tokenBudget = config.tokenBudget ?? 120000;
    this.initialPrompt = config.initialPrompt;
    this.assemblyOrder = config.assemblyOrder;
    this.disabledSections = config.disabledSections;
    this.tracing = config.tracing;
    this.coreEventSink = createGameSessionCoreEventSink(config);
    this.protocolVersion = resolveRuntimeProtocolVersion(config.protocolVersion);
    this.parserManifest = config.parserManifest;
    this.characters = config.characters ?? [];
    this.backgrounds = config.backgrounds ?? [];
    if (!this.parserManifest) {
      throw new Error(`[GameSession] protocolVersion="${this.protocolVersion}" requires parserManifest`);
    }
  }

  // ============================================================================
  // Core Loop — Generate + Receive
  // ============================================================================

  private async coreLoop(): Promise<void> {
    while (this.active) {
      // --- Generate Phase ---
      const turn = await this.beginGenerateTurn();
      const generateResult = await this.runGeneratePhase(turn);
      if (generateResult.stopped) break;

      // --- 本轮 generate 结束检查：剧情是否已结束？ ---
      // LLM 在本轮内调用了 end_scenario → onScenarioEnd 回调设了 scenarioEnded=true。
      // 这里统一处理：持久化 finished 状态 + 退出外循环，不再进入 Receive 阶段。
      if (this.scenarioEnded && this.active) {
        this.active = false;
        await this.publishDurableCoreEvent({
          type: 'session-finished',
          reason: this.scenarioEndReason,
          snapshot: await this.createSessionSnapshot(),
        });
        break;
      }

      // --- Receive Phase ---
      // 方案 B（turn-bounded）下所有 generate() 返回后都走这里等输入：
      //   - pendingSignal 非空：LLM 调 signal_input_needed → stopWhen 拦截 → 用 signal
      //     的 hint/choices 做输入请求（choice 或 freetext，看 choices 长度）
      //   - pendingSignal 空：LLM 自然停止 / maxSteps 触发 → 用 freetext 兜底
      // 玩家输入后 clear pendingSignal，next iteration 开新 generate()。
      if (this.active) {
        await this.runReceivePhase(turn);
      }
    }
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private async beginGenerateTurn(): Promise<number> {
    const turn = this.stateStore.getTurn() + 1;
    this.stateStore.setTurn(turn);
    return turn;
  }

  private async runGeneratePhase(turn: number): Promise<{ stopped: boolean }> {
    const llmClient = this.llmClient;
    const runtime = createGenerateTurnRuntime({
      turn,
      stateStore: this.stateStore,
      memory: this.memory,
      llmClient,
      segments: this.segments,
      enabledTools: this.enabledTools,
      tokenBudget: this.tokenBudget,
      initialPrompt: this.initialPrompt,
      assemblyOrder: this.assemblyOrder,
      disabledSections: this.disabledSections,
      tracing: this.tracing,
      coreEventSink: this.coreEventSink,
      protocolVersion: this.protocolVersion,
      parserManifest: this.parserManifest,
      characters: this.characters,
      backgrounds: this.backgrounds,
      currentScene: this.currentScene,
      // narrative-rewrite invoke：默认走 GameSession 自己的 LLMClient.simpleGenerate
      // （单轮、无 tools、无 followup）。session-manager 不需要额外注入。
      rewriter: async (opts) => {
        const out = await llmClient.simpleGenerate({
          systemPrompt: opts.systemPrompt,
          userMessage: opts.userMessage,
          abortSignal: opts.abortSignal,
          onTextChunk: opts.onTextChunk,
        });
        return {
          text: out.text,
          finishReason: out.finishReason,
          model: out.model,
          inputTokens: out.inputTokens,
          outputTokens: out.outputTokens,
        };
      },
      buildRetrievalQuery: () => this.buildRetrievalQuery(),
      isActive: () => this.active,
      onScenarioEnd: (reason) => {
        // 只记下 flag；实际的"退出循环 + 持久化"在本轮 generate 返回后做。
        // 这样 LLM 在 end_scenario 之后还能继续输出一小段收尾文字再 stop。
        this.scenarioEnded = true;
        this.scenarioEndReason = reason;
      },
    });

    this.activeGenerateTurn = runtime;
    try {
      const result = await runtime.run();
      this.currentScene = result.currentScene;
      this.pendingSignal = result.pendingSignal;
      return { stopped: result.stopped };
    } finally {
      if (this.activeGenerateTurn === runtime) {
        this.activeGenerateTurn = null;
      }
    }
  }

  private async runReceivePhase(turn: number): Promise<void> {
    // Snapshot pendingSignal 副本：GenerateTurnRuntime 已经记录完 signal，
    // 我们在 coreLoop 内消费。下一轮 generate 开始前清零。
    const signal = this.pendingSignal;
    const waitingHint = signal?.hint ?? null;
    const waitingChoices = signal?.choices && signal.choices.length > 0 ? signal.choices : null;
    const requestId = toInputRequestId(turn);

    // 2026-04-24：stateVars 也在这一刻持久化 —— 本轮 LLM update_state
    //    改动的 state（比如 chapter 切换）必须立即入库，否则断线重连时
    //    DB state 滞后一个回合（history 在 ch2、state_vars 仍 ch1）
    const memSnapWait = await this.memory.snapshot();
    await this.publishDurableCoreEvent({
      type: 'waiting-input-started',
      turnId: toTurnId(turn),
      requestId,
      source: signal ? 'signal' : 'fallback',
      causedByBatchId: toBatchId(signal?.batchId),
      request: createInputRequest(waitingHint, waitingChoices),
      snapshot: {
        turn,
        stateVars: this.stateStore.getAll(),
        memorySnapshot: memSnapWait,
        currentScene: copyScene(this.currentScene),
      },
    });

    const inputText = await this.waitForInput();
    if (!this.active) return;

    if (inputText) {
      // 方案 B：pendingSignal 的 choices 拿来算 selectedIndex（命中 → choice）
      const payload = signal
        ? computeReceivePayload(inputText, signal.choices)
        : ({ inputType: 'freetext' as const });

      await this.memory.appendTurn({
        turn,
        role: 'receive',
        content: inputText,
        tokenCount: estimateTokens(inputText),
      });

      const memSnapRx = await this.memory.snapshot();
      const receiveBatchId = crypto.randomUUID() as BatchId;
      await this.publishDurableCoreEvent({
        type: 'player-input-recorded',
        turnId: toTurnId(turn),
        requestId,
        batchId: receiveBatchId,
        text: inputText,
        payload,
        sentence: {
          kind: 'player_input',
          text: inputText,
          ...(payload.selectedIndex !== undefined ? { selectedIndex: payload.selectedIndex } : {}),
          // V.13 turn 边界舞台清空：player_input.sceneRef.sprites=[] 让玩家输入
          // 气泡渲染时立绘退场，UI 视觉上"上一轮叙事结束 → 舞台清空 → 下一轮
          // 叙事开始"。下个 turn 第一个 unit 是 dialogue 时由 V.10 unit-resolved
          // sprites=[speaker] 自动重建（边界保护通过 V.10 单元独立 resolution
          // 满足）。background 保留：场景不切，只清立绘。`this.currentScene` 不
          // 动 → retrieve query 的 char_ids 信号不退化。
          sceneRef: { background: this.currentScene.background, sprites: [] },
          turnNumber: turn,
          index: Date.now(),
        },
        snapshot: {
          turn,
          stateVars: this.stateStore.getAll(),
          memorySnapshot: memSnapRx,
          currentScene: copyScene(this.currentScene),
        },
      });
    }

    // 清状态：下一 iteration 从全新 generate 开始
    this.pendingSignal = null;
  }

  /**
   * 为本轮 generate 构造 Memory.retrieve 的 query。
   *
   * 当前形态：`<scene_id> <char_ids...>. <lastPlayerInput>`
   *   - scene_id：state_vars.current_scene（computeFocus 推断）
   *   - char_ids：this.currentScene.sprites 的 id 列表 —— 当前在场角色
   *     （注：focus.characters 是 v2 扩展点尚未在 computeFocus 里投影，
   *      这里直接读 currentScene.sprites 拿真实"现场立绘"集合。两路最终
   *      会统一到 focus 维度，但 MVP 先各取所需）
   *   - lastPlayerInput：submitInput 写入的玩家话语
   *
   * 设计选择（2026-04-26）：
   *   - **加 char_ids 的原因**：mem0 / memorax 是语义检索，给它角色 id 比单
   *     scene 多一个语义锚点 —— "当前场景且这些角色在场时发生过的事" 召回率
   *     显著高于仅 scene
   *   - **保留 lastPlayerInput**：玩家话题往往跑在 state 变量更新之前，
   *     是即时关注点的最快信号；冗余但低成本
   *   - **下一场景的 gap 不在此层解决**：retrieve 在 LLM 跑之前发生，
   *     "下个场景" 本质不可知。靠 (a) 下一 turn 自动追上、(b) LLM 的
   *     query_memory 工具自助补查 兜底
   *
   * ⚠ 扩展点（按工程成本递增）：
   *   - pin 几条剧本主线 facts，retrieve summary 永远拼到顶
   *   - 多 query 并行 retrieve 合并结果（需要 script 侧"可能下一场景集合"）
   *   - 用便宜 LLM 根据 state + 近 N 条叙事生成更精炼的 query
   *
   * 升级只改这个函数，assembleContext / Memory.retrieve 完全不动。
   *
   * 空字符串合法：adapter 按契约兜底（legacy → entries 空数组；mem0 按策略）。
   */
  private async buildRetrievalQuery(): Promise<string> {
    const focus = computeFocus(this.stateStore.getAll());
    const charIds = this.currentScene.sprites.map((s) => s.id);
    const sceneAndChars = [focus.scene, ...charIds]
      .filter((part): part is string => !!part)
      .join(' ');
    return [sceneAndChars, this.lastPlayerInput]
      .filter((part) => !!part)
      .join('. ');
  }

  private waitForInput(): Promise<string> {
    return new Promise<string>((resolve) => {
      this.inputResolve = resolve;
    });
  }

  private publishCoreEvent(event: Parameters<CoreEventSink['publish']>[0]): void {
    this.coreEventSink?.publish(event);
  }

  private async publishDurableCoreEvent(event: CoreEvent): Promise<void> {
    this.publishCoreEvent(event);
    await this.coreEventSink?.flushDurable?.();
  }

  private async createSessionSnapshot(): Promise<SessionSnapshot> {
    return {
      turn: this.stateStore.getTurn(),
      stateVars: this.stateStore.getAll(),
      memorySnapshot: await this.memory.snapshot(),
      currentScene: copyScene(this.currentScene),
    };
  }

}

function createGameSessionCoreEventSink(
  config: Pick<GameSessionConfig | RestoreConfig, 'coreEventSink' | 'persistence'>,
): CoreEventSink | undefined {
  if (!config.persistence) {
    return config.coreEventSink;
  }

  return createDurableFirstCoreEventSink({
    durableSinks: [
      createSessionPersistenceCoreEventSink(config.persistence),
    ],
    realtimeSinks: config.coreEventSink ? [config.coreEventSink] : [],
    isDurableEvent: isSessionPersistenceCoreEvent,
  });
}

function normalizeRestoredFrom(status: string): 'idle' | 'generating' | 'waiting-input' | 'finished' {
  return status === 'generating' ||
    status === 'waiting-input' ||
    status === 'finished'
    ? status
    : 'idle';
}

function copyScene(scene: SceneState): SceneState {
  return {
    background: scene.background,
    sprites: scene.sprites.map((sprite) => ({ ...sprite })),
  };
}
