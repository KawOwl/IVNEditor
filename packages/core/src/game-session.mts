/**
 * GameSession — 端到端集成层
 *
 * 串联所有核心模块：
 *   StateStore, MemoryManager, ContextAssembler, ToolExecutor, LLMClient
 *
 * 通过 SessionEmitter 输出运行时事件，不直接依赖 WebSocket、Zustand 或 DOM。
 * 这使得 GameSession 可以被浏览器、后端服务或离线评测任务消费。
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
import { estimateTokens } from '#internal/tokens';
import { computeFocus } from '#internal/focus';
import { LLMClient } from '#internal/llm-client';
import type { LLMConfig } from '#internal/llm-client';
import type { SessionEmitter } from '#internal/session-emitter';
import type { ParserManifest } from '#internal/narrative-parser-v2';
import { computeReceivePayload } from '#internal/game-session/input-payload';
import {
  createGenerateTurnRuntime,
  type GenerateTurnPendingSignal,
  type GenerateTurnRuntime,
} from '#internal/game-session/generate-turn-runtime';
import type {
  GameSessionConfig,
  RestoreConfig,
  SessionPersistence,
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
export type {
  GameSessionConfig,
  GenerateTraceHandle,
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
  private emitter: SessionEmitter;

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
  private persistence?: SessionPersistence;
  private tracing?: SessionTracing;
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
   * v1 路径：由 change_scene / change_sprite / clear_stage 工具演进（applyScenePatch）。
   * v2 路径：由 parser-v2 每条 Sentence 的 sceneRef 更新。
   * start() 时从 manifest.defaultScene 或 {background:null, sprites:[]} 初始化，
   * restore() 时从 DB 恢复。每次变化在 generate 结束后持久化。
   */
  private currentScene: SceneState = {
    background: null,
    sprites: [],
  };

  /**
   * 视觉 IR 协议版本。缺省 v1-tool-call；v2-declarative-visual 使用 parser-v2，
   * 且不再注册视觉工具驱动的 scene_change Sentence。
   */
  private protocolVersion: ProtocolVersion = 'v1-tool-call';
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

  constructor(emitter: SessionEmitter) {
    this.emitter = emitter;
  }

  /** 即时更新 LLM 配置（下一次 generate 生效，无需重启会话） */
  updateLLMConfig(patch: Partial<LLMConfig>): void {
    this.llmClient?.updateConfig(patch);
  }

  /** Initialize and start the game session */
  async start(config: GameSessionConfig): Promise<void> {
    this.emitter.reset();
    this.emitter.setStatus('loading');

    try {
      await this.initializeCore(config);

      // inheritedSummary 已从架构里移除：章节不再是 memory 生命周期事件。

      // M3: 初始化 currentScene —— 用剧本 defaultScene，否则空
      this.currentScene = config.defaultScene ?? { background: null, sprites: [] };
      this.emitter.emitSceneChange(this.currentScene);

      // Sync initial debug/output state
      await this.syncDebugState();

      // Start core loop
      this.active = true;
      await this.coreLoop();
    } catch (error) {
      if (this.active) {
        this.emitter.setError(error instanceof Error ? error.message : String(error));
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
    this.emitter.setStatus('loading');

    try {
      await this.initializeCore(config);

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
      this.emitter.emitSceneChange(this.currentScene);

      // 同步调试输出
      await this.syncDebugState();

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
        this.emitter.setStatus('finished');
        return;
      }

      // 根据恢复时的状态决定进入点
      if (config.status === 'waiting-input') {
        // 恢复输入请求状态（choices/hint）
        if (config.inputHint) this.emitter.setInputHint(config.inputHint);
        if (config.inputType === 'choice' && config.choices?.length) {
          this.emitter.setInputType('choice', config.choices);
        }
        this.emitter.setStatus('waiting-input');

        // 等玩家输入，然后进入 coreLoop
        const inputText = await this.waitForInput();
        if (!this.active) return;

        if (inputText) {
          // restore 路径下玩家刚从 DB 恢复的 choices 里选 → 算 selectedIndex
          const payload = computeReceivePayload(inputText, config.choices ?? null);
          this.emitter.appendEntry({ role: 'receive', content: inputText });
          this.emitPlayerInputSentence(inputText, payload.selectedIndex);
          await this.memory.appendTurn({
            turn: config.turn,
            role: 'receive',
            content: inputText,
            tokenCount: estimateTokens(inputText),
          });
          const memSnap = await this.memory.snapshot();
          await this.persistence?.onReceiveComplete({
            entry: { role: 'receive', content: inputText },
            stateVars: this.stateStore.getAll(),
            turn: config.turn,
            memorySnapshot: memSnap,
            payload,
            // migration 0011：玩家一次提交独立 batchId（未来多模态一次提交多 entry 共享）
            batchId: crypto.randomUUID(),
          }).catch((e) => console.error('[Persistence] onReceiveComplete (restore) failed:', e));
        }

        this.emitter.setInputHint(null);
        this.emitter.setInputType('freetext');

        // 继续正常 coreLoop
        await this.coreLoop();
      } else {
        // idle 或 generating → 从头开始 coreLoop
        await this.coreLoop();
      }
    } catch (error) {
      if (this.active) {
        this.emitter.setError(error instanceof Error ? error.message : String(error));
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

    this.emitter.setStatus('idle');
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
      reader: config.narrativeReader,
    });
    this.segments = config.segments;
    this.enabledTools = config.enabledTools ?? [];
    this.tokenBudget = config.tokenBudget ?? 120000;
    this.initialPrompt = config.initialPrompt;
    this.assemblyOrder = config.assemblyOrder;
    this.disabledSections = config.disabledSections;
    this.persistence = config.persistence;
    this.tracing = config.tracing;
    this.protocolVersion = config.protocolVersion ?? 'v1-tool-call';
    this.parserManifest = config.parserManifest;
    this.characters = config.characters ?? [];
    this.backgrounds = config.backgrounds ?? [];
    if (this.protocolVersion === 'v2-declarative-visual' && !this.parserManifest) {
      throw new Error('[GameSession] protocolVersion="v2-declarative-visual" requires parserManifest');
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
        this.emitter.setStatus('finished');
        await this.persistence?.onScenarioFinished?.({
          reason: this.scenarioEndReason,
        }).catch((e) => console.error('[Persistence] onScenarioFinished failed:', e));
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
    this.emitter.setStatus('generating');
    const turn = this.stateStore.getTurn() + 1;
    this.stateStore.setTurn(turn);

    // ① 持久化：generate 开始
    await this.persistence?.onGenerateStart(turn).catch((e) =>
      console.error('[Persistence] onGenerateStart failed:', e));

    return turn;
  }

  private async runGeneratePhase(turn: number): Promise<{ stopped: boolean }> {
    const runtime = createGenerateTurnRuntime({
      turn,
      emitter: this.emitter,
      stateStore: this.stateStore,
      memory: this.memory,
      llmClient: this.llmClient,
      segments: this.segments,
      enabledTools: this.enabledTools,
      tokenBudget: this.tokenBudget,
      initialPrompt: this.initialPrompt,
      assemblyOrder: this.assemblyOrder,
      disabledSections: this.disabledSections,
      persistence: this.persistence,
      tracing: this.tracing,
      protocolVersion: this.protocolVersion,
      parserManifest: this.parserManifest,
      characters: this.characters,
      backgrounds: this.backgrounds,
      currentScene: this.currentScene,
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
    const waitingInputType = waitingChoices ? 'choice' : 'freetext';

    // 输入请求状态：hint + input-type（以及可选 choices）
    this.emitter.setInputHint(waitingHint);
    this.emitter.setInputType(waitingInputType, waitingChoices);
    this.emitter.setStatus('waiting-input');

    // ③ 持久化：onWaitingInput 快照（signal / freetext 统一调一次）
    //    2026-04-24：stateVars 也在这一刻持久化 —— 本轮 LLM update_state
    //    改动的 state（比如 chapter 切换）必须立即入库，否则断线重连时
    //    DB state 滞后一个回合（history 在 ch2、state_vars 仍 ch1）
    const memSnapWait = await this.memory.snapshot();
    await this.persistence?.onWaitingInput({
      hint: waitingHint,
      inputType: waitingInputType,
      choices: waitingChoices,
      memorySnapshot: memSnapWait,
      currentScene: this.currentScene,
      stateVars: this.stateStore.getAll(),
    }).catch((e) => console.error('[Persistence] onWaitingInput failed:', e));

    const inputText = await this.waitForInput();
    if (!this.active) return;

    // Clear error banner on new input
    this.emitter.setError(null);

    if (inputText) {
      // 方案 B：pendingSignal 的 choices 拿来算 selectedIndex（命中 → choice）
      const payload = signal
        ? computeReceivePayload(inputText, signal.choices)
        : ({ inputType: 'freetext' as const });

      this.emitter.appendEntry({ role: 'receive', content: inputText });
      this.emitPlayerInputSentence(inputText, payload.selectedIndex);

      await this.memory.appendTurn({
        turn,
        role: 'receive',
        content: inputText,
        tokenCount: estimateTokens(inputText),
      });

      // ④ 持久化：receive 完成
      const memSnapRx = await this.memory.snapshot();
      await this.persistence?.onReceiveComplete({
        entry: { role: 'receive', content: inputText },
        stateVars: this.stateStore.getAll(),
        turn,
        memorySnapshot: memSnapRx,
        payload,
        // migration 0011：玩家一次提交独立 batchId（未来多模态一次提交多 entry 共享）
        batchId: crypto.randomUUID(),
      }).catch((e) => console.error('[Persistence] onReceiveComplete failed:', e));
    }

    // 清状态：下一 iteration 从全新 generate 开始
    this.pendingSignal = null;
    this.emitter.setInputHint(null);
    this.emitter.setInputType('freetext');
  }

  /**
   * 为本轮 generate 构造 Memory.retrieve 的 query。
   *
   * v1.1 版本（Focus Injection MVP）：拼接"当前 focus.scene + 最近玩家输入"。
   *   - scene 来自 state_vars.current_scene（由 computeFocus 推断）
   *   - lastPlayerInput 是 submitInput 写入的
   *
   * 为什么拼 focus：给 Memory.retrieve 更结构化的信号，让 mem0 这类语义
   * 检索能找到"此场景下发生过的事"而不只是"玩家话里提到的关键词"。
   * legacy / llm-summarizer 下 query 对 summary 影响不大，但无害。
   *
   * ⚠ 扩展点保留。未来可能升级为：
   *   - 加 chars / stage 维度
   *   - 用便宜 LLM 根据 state + 最近叙事生成更精炼的 query
   *   - 多 query 并行 retrieve 合并结果
   *
   * 升级只改这个函数，assembleContext / Memory.retrieve 完全不动。
   *
   * 空字符串合法：adapter 按契约兜底（legacy → entries 空数组；mem0 按策略）。
   */
  private async buildRetrievalQuery(): Promise<string> {
    const focus = computeFocus(this.stateStore.getAll());
    return [
      focus.scene,
      // v2: focus.stage,
      // v2: focus.characters?.join(', '),
      this.lastPlayerInput,
    ].filter((part): part is string => !!part).join('. ');
  }

  /**
   * 把玩家输入 emit 成一条 `player_input` Sentence，让 VN / ivn-xml 消费端
   * 能投影出"玩家的回复气泡"。
   *
   * 在 signal 挂起路径和外循环 Receive 路径下都要调，保持叙事流里玩家和 GM
   * 一问一答的顺序。restore 路径也会为 `role='receive'` entries 合成同样的 Sentence
   * （在 ws-client-emitter 的 'restored' 分支里做）。
   *
   * index 用 Date.now()：player_input 不在 generate 内部的 turnSentenceIndex
   * 序列里，只需要全局单调即可（消费端按 appendSentence 顺序推进，index 字段
   * 主要是诊断标识）。
   */
  private emitPlayerInputSentence(text: string, selectedIndex?: number): void {
    this.emitter.appendSentence({
      kind: 'player_input',
      text,
      ...(selectedIndex !== undefined ? { selectedIndex } : {}),
      sceneRef: { ...this.currentScene },
      turnNumber: this.stateStore.getTurn(),
      index: Date.now(),
    });
  }

  private waitForInput(): Promise<string> {
    return new Promise<string>((resolve) => {
      this.inputResolve = resolve;
    });
  }

  private async syncDebugState(): Promise<void> {
    // memoryEntryCount / memorySummaryCount 纯诊断用，从 snapshot 拆。
    // Legacy 下 snapshot 同步完成；mem0 下是网络请求但数值不是热路径，
    // 可接受。如果后续发现压力就改为 adapter 暴露一个 stats() 轻量方法。
    const memSnap = await this.memory.snapshot();
    const entries = (memSnap.entries as unknown[] | undefined) ?? [];
    const summaries = (memSnap.summaries as string[] | undefined) ?? [];
    this.emitter.updateDebug({
      stateVars: this.stateStore.getAll(),
      totalTurns: this.stateStore.getTurn(),
      memoryEntryCount: entries.length,
      memorySummaryCount: summaries.length,
    });
  }

}
