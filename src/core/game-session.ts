/**
 * GameSession — 端到端集成层
 *
 * 串联所有核心模块：
 *   StateStore, MemoryManager, ContextAssembler, ToolExecutor, LLMClient
 *
 * 通过 SessionEmitter 接口向视图层推送事件，不直接依赖 Zustand。
 * 这使得 GameSession 可以在前端或后端运行。
 *
 * 核心循环：Generate + Receive
 *   1. Generate: 组装 context → 调用 LLM（agentic tool loop）→ 追加记忆 → 按需压缩
 *      - signal_input_needed 使用挂起模式：execute 挂起等玩家输入，LLM 拿到结果后继续
 *      - 一次 generate() 内可能有 0 次、1 次或多次玩家互动
 *   2. Receive: LLM 自然停止后，等待玩家输入（fallback，不经过 signal_input_needed）
 *   循环直到 session 被停止
 *
 * 对外只暴露简单的 API：
 *   - start(config): 初始化并开始运行
 *   - submitInput(text): 提交玩家输入
 *   - stop(): 停止
 */

import type {
  PromptSegment,
  StateSchema,
  MemoryConfig,
} from './types';
import { StateStore } from './state-store';
import type { Memory } from './memory/types';
import { createMemory } from './memory/factory';
import { estimateTokens } from './tokens';
import { assembleContext } from './context-assembler';
import { createTools, getEnabledTools } from './tool-executor';
import type { SignalInputOptions } from './tool-executor';
import { LLMClient } from './llm-client';
import type { LLMConfig } from './llm-client';
import type { SessionEmitter } from './session-emitter';
import { NarrativeParser } from './narrative-parser';
import type { Sentence, ParticipationFrame, SceneState } from './types';

// ============================================================================
// Types
// ============================================================================

/**
 * SessionPersistence — 可选的持久化回调接口
 *
 * 远程模式下由 server 注入实现（写 DB），本地模式不传。
 * GameSession 在 coreLoop 的关键状态转换点调用这些回调。
 */
export interface SessionPersistence {
  /** generate 阶段开始 */
  onGenerateStart(turn: number): Promise<void>;

  /**
   * 一段 streaming entry 结束时（finalize 前）调用。
   * 触发时机：
   *   1. signal_input_needed 挂起前（保证挂起时叙事已入库）
   *   2. generate() 自然返回后（完整一轮叙事结束）
   *
   * 每次调用保存一条独立的 narrative_entry 到 DB。
   */
  onNarrativeSegmentFinalized(data: {
    entry: { role: string; content: string; reasoning?: string; toolCalls?: unknown[]; finishReason?: string };
  }): Promise<void>;

  /** generate() 全部结束后同步 memory 快照 + preview + VN 场景（不再负责 entry 入库） */
  onGenerateComplete(data: {
    memoryEntries: unknown[];
    memorySummaries: string[];
    preview?: string | null;
    /** M3: VN 当前场景快照，持久化到 playthroughs.current_scene */
    currentScene?: SceneState | null;
  }): Promise<void>;

  /** 进入等待输入状态（signal_input_needed 或外循环 receive phase） */
  onWaitingInput(data: {
    hint: string | null;
    inputType: string;
    choices: string[] | null;
    /** signal 路径会传最新 memory 快照，让断线重连后 history 不丢 */
    memoryEntries?: unknown[];
    memorySummaries?: string[];
  }): Promise<void>;

  /** 玩家输入完成 */
  onReceiveComplete(data: {
    entry: { role: string; content: string };
    stateVars: Record<string, unknown>;
    turn: number;
    memoryEntries: unknown[];
    memorySummaries: string[];
  }): Promise<void>;

  /**
   * 剧情结束（LLM 调用了 end_scenario）。持久化层应把 status 标记为
   * 'finished'，并可以记录 reason。此后该 playthrough 不再接受玩家输入。
   */
  onScenarioFinished?(data: {
    reason?: string;
  }): Promise<void>;
}

// ============================================================================
// SessionTracing — 可观测性回调接口（可选，远程模式 server 注入）
// ============================================================================

/**
 * 一次 generate() 的 trace handle。
 * 提供 generation + tool span + event 子操作。
 * 所有方法都是 fire-and-forget，失败不能影响主流程（实现方自己 catch）。
 *
 * 设计说明：一次 generate() 的 agentic loop 内可能有多个 LLM API 调用
 * （step 0 → tool → step 1 → tool → step N）。每个 step 产生独立的
 * generation span，由 recordStep 调用创建。不再使用 start/end 成对
 * 的模式——那种模式只能记录一次调用。
 */
export interface GenerateTraceHandle {
  /**
   * 设置整个 trace 的 input（初始 systemPrompt + messages）。
   * 在 generate() 调用前调一次，用于 UI 展示调用上下文。
   */
  setInput(input: {
    systemPrompt: string;
    messages: Array<{ role: string; content: string }>;
  }): void;

  /**
   * 记录一个 step 的完整信息（每个内部 LLM API 调用对应一个 step）。
   * 创建一个已完成的 generation span。
   */
  recordStep(step: {
    stepNumber: number;
    text: string;
    reasoning?: string;
    finishReason: string;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
    /**
     * 此 step 的 content parts 类型集合（去重）。
     * 例：['text', 'tool-call'] = 叙事 + 工具；['tool-call'] = 纯工具步。
     * tracing 实现可据此对 span 命名、打 metadata，不用字数判断。
     */
    partKinds: string[];
    /**
     * AI SDK 汇报的 step.response.timestamp（LLM 响应开始的时间点）。
     * tracing 层用它作为 generation span 的时间戳，避免被同 step 内的
     * signal_input_needed 挂起污染（见 StepInfo 字段注释）。
     */
    responseTimestamp?: Date;
    /**
     * 该 step 发给 LLM 的完整 messages 简化版。
     * tracing 层写进 generation span 的 input，替代初始的 this.initialInput。
     */
    stepInputMessages?: Array<{ role: string; content: string }>;
  }): void;

  /** 开始一次工具调用，返回 handle 用于结束 */
  startToolCall(name: string, args: unknown): ToolCallTraceHandle;

  /** 记录一个事件（player_input / 等） */
  event(name: string, input?: unknown, metadata?: Record<string, unknown>): void;

  /** 错误事件 */
  error(message: string, phase: string): void;

  /** 结束整个 trace */
  end(finalOutput?: unknown): void;
}

export interface ToolCallTraceHandle {
  end(output: unknown, error?: string): void;
}

/**
 * SessionTracing — 可选的可观测性接口
 *
 * 远程模式下由 server 注入 Langfuse 实现；本地模式不传 → 无观测。
 * 接口保持最小：core 层不需要知道 Langfuse 的存在。
 */
export interface SessionTracing {
  /** 每次 generate() 开始调用，返回该轮的 trace handle */
  startGenerateTrace(turn: number, metadata?: Record<string, unknown>): GenerateTraceHandle;

  /** restore 成功时调用，在 Langfuse 打一个"断点"标记 */
  markSessionRestored(turn: number, metadata?: Record<string, unknown>): void;
}

/**
 * RestoreConfig — 从持久化快照恢复会话所需的数据
 */
export interface RestoreConfig {
  /** Memory.scope 字段 —— 构造 Memory adapter 时绑定 */
  playthroughId: string;
  userId: string;
  chapterId: string;

  segments: PromptSegment[];
  stateSchema: StateSchema;
  memoryConfig: MemoryConfig;
  llmConfig: LLMConfig;
  enabledTools?: string[];
  tokenBudget?: number;
  initialPrompt?: string;
  assemblyOrder?: string[];
  disabledSections?: string[];
  persistence?: SessionPersistence;
  tracing?: SessionTracing;
  // 恢复数据
  stateVars: Record<string, unknown>;
  turn: number;
  memoryEntries: unknown[];       // MemoryEntry[] from DB (JSONB) —— Commit 4 会改成 memorySnapshot
  memorySummaries: string[];
  status: string;                 // 恢复时的状态
  inputHint?: string | null;
  inputType?: string;
  choices?: string[] | null;
  /** VN 当前场景快照（M3）。null = 老 playthrough，取 manifest.defaultScene 或空。 */
  currentScene?: SceneState | null;
  /** 场景默认值，当没有 currentScene 快照时用 */
  defaultScene?: SceneState;
}

export interface GameSessionConfig {
  /** Memory.scope 字段 —— 构造 Memory adapter 时绑定 */
  playthroughId: string;
  userId: string;
  chapterId: string;

  segments: PromptSegment[];
  stateSchema: StateSchema;
  memoryConfig: MemoryConfig;
  llmConfig: LLMConfig;
  enabledTools?: string[];       // optional tool names to enable
  tokenBudget?: number;          // context window budget (default: 120000)
  initialPrompt?: string;        // 首轮 user message（等效于 prompt.txt）
  assemblyOrder?: string[];      // 自定义 prompt 组装顺序
  disabledSections?: string[];   // 被禁用的 section ID 列表
  persistence?: SessionPersistence;  // 可选持久化（远程模式写 DB）
  tracing?: SessionTracing;          // 可选可观测性（远程模式接 Langfuse）
  /** VN 模式首次开始时 currentScene 的初值（M3）。剧本 manifest.defaultScene 透传过来。 */
  defaultScene?: SceneState;
}

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
  /** 当前 generate 轮次的 trace handle（供 signal_input_needed 路径记录 player_input 事件） */
  private currentTraceHandle?: GenerateTraceHandle;

  /**
   * 当前 streaming entry 的叙事文本累积区。
   * 用途：signal_input_needed 挂起时先把这段文本持久化到 DB，
   * 避免 generate() 一直挂起导致的叙事丢失。
   * 每次 beginStreamingEntry 前重置，每次 finalize 前 flush 到 DB。
   */
  private currentNarrativeBuffer = '';

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
   * VN 当前场景快照（M3）。由 change_scene / change_sprite / clear_stage 工具演进。
   * start() 时从 manifest.defaultScene 或 {background:null, sprites:[]} 初始化，
   * restore() 时从 DB 恢复。每次变化会发给 emitter 并在 generate 结束后持久化。
   */
  private currentScene: import('./types').SceneState = {
    background: null,
    sprites: [],
  };

  /**
   * M3: applyScenePatch 完成后额外触发——发出 WS 事件 + 产出 scene_change Sentence。
   * 只在 generate() 执行期间非 null。由 generate() 内部初始化。
   */
  private scenePatchEmitter:
    | ((transition?: 'fade' | 'cut' | 'dissolve') => void)
    | null = null;

  // 外循环 Receive 阶段的挂起 Promise（LLM 自然停止后等玩家输入）
  private inputResolve: ((text: string) => void) | null = null;

  // 内循环挂起 Promise（signal_input_needed 等玩家输入）
  private signalInputResolve: ((text: string) => void) | null = null;

  // 用于中断进行中的 generate()（停止/重置时防挂死）
  private abortController: AbortController | null = null;

  // compressFn 从 game-session 移除 —— 现在由 Memory adapter 构造时注入
  // （Legacy 用 truncatingCompressFn，LLMSummarizer 用真 LLM）

  constructor(emitter: SessionEmitter) {
    this.emitter = emitter;
  }

  /** 即时更新 LLM 配置（下一次 generate 生效，无需重启会话） */
  updateLLMConfig(patch: Partial<import('./llm-client').LLMConfig>): void {
    this.llmClient?.updateConfig(patch);
  }

  /** Initialize and start the game session */
  async start(config: GameSessionConfig): Promise<void> {
    this.emitter.reset();
    this.emitter.setStatus('loading');

    try {
      // Initialize core modules
      this.stateStore = new StateStore(config.stateSchema);
      this.memory = await createMemory({
        scope: {
          playthroughId: config.playthroughId,
          userId: config.userId,
          chapterId: config.chapterId,
        },
        config: config.memoryConfig,
      });
      this.llmClient = new LLMClient(config.llmConfig);
      this.segments = config.segments;
      this.enabledTools = config.enabledTools ?? [];
      this.tokenBudget = config.tokenBudget ?? 120000;
      this.initialPrompt = config.initialPrompt;
      this.assemblyOrder = config.assemblyOrder;
      this.disabledSections = config.disabledSections;
      this.persistence = config.persistence;
      this.tracing = config.tracing;

      // inheritedSummary 已从架构里移除：章节不再是 memory 生命周期事件。

      // M3: 初始化 currentScene —— 用剧本 defaultScene，否则空
      this.currentScene = config.defaultScene ?? { background: null, sprites: [] };
      this.emitter.emitSceneChange(this.currentScene);

      // Sync initial state to UI
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
      // 初始化核心模块（同 start）
      this.stateStore = new StateStore(config.stateSchema);
      this.memory = await createMemory({
        scope: {
          playthroughId: config.playthroughId,
          userId: config.userId,
          chapterId: config.chapterId,
        },
        config: config.memoryConfig,
      });
      this.llmClient = new LLMClient(config.llmConfig);
      this.segments = config.segments;
      this.enabledTools = config.enabledTools ?? [];
      this.tokenBudget = config.tokenBudget ?? 120000;
      this.initialPrompt = config.initialPrompt;
      this.assemblyOrder = config.assemblyOrder;
      this.disabledSections = config.disabledSections;
      this.persistence = config.persistence;
      this.tracing = config.tracing;

      // 注入持久化快照
      this.stateStore.restore(config.stateVars, config.turn);
      // DB 里目前还是两列格式（Commit 4 会合并为单列 memorySnapshot）。
      // 这里重组成 legacy-v1 snapshot 再喂给 LegacyMemory.restore。
      await this.memory.restore({
        kind: 'legacy-v1',
        entries: config.memoryEntries as import('./types').MemoryEntry[],
        summaries: config.memorySummaries,
      });

      // M3: 恢复 currentScene —— 优先 DB 快照，其次 manifest 默认，最后空
      this.currentScene =
        config.currentScene ??
        config.defaultScene ??
        { background: null, sprites: [] };
      this.emitter.emitSceneChange(this.currentScene);

      // 同步 UI
      await this.syncDebugState();

      // 可观测性：恢复标记，方便 Langfuse UI 中识别"断点"
      this.tracing?.markSessionRestored(config.turn, {
        status: config.status,
        hasEntries: Array.isArray(config.memoryEntries) && config.memoryEntries.length > 0,
      });

      this.active = true;

      // 如果这个 playthrough 已经结束了，直接进入 finished 状态不再启动循环。
      // 前端会看到只读的叙事历史。
      if (config.status === 'finished') {
        this.active = false;
        this.emitter.setStatus('finished');
        return;
      }

      // 根据恢复时的状态决定进入点
      if (config.status === 'waiting-input') {
        // 恢复 UI 状态（choices/hint）
        if (config.inputHint) this.emitter.setInputHint(config.inputHint);
        if (config.inputType === 'choice' && config.choices?.length) {
          this.emitter.setInputType('choice', config.choices);
        }
        this.emitter.setStatus('waiting-input');

        // 等玩家输入，然后进入 coreLoop
        const inputText = await this.waitForInput();
        if (!this.active) return;

        if (inputText) {
          this.emitter.appendEntry({ role: 'receive', content: inputText });
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
            memoryEntries: memSnap.entries as unknown[],
            memorySummaries: (memSnap.summaries as string[]) ?? [],
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

  /** Submit player input — 分两路：挂起中（signal_input_needed）或外循环（Receive 阶段） */
  async submitInput(text: string): Promise<void> {
    // 捕获本次 player input 作为下一次 Memory.retrieve 的 default query
    this.lastPlayerInput = text;

    if (this.signalInputResolve) {
      // 挂起模式：signal_input_needed 正在等玩家输入
      const resolve = this.signalInputResolve;
      this.signalInputResolve = null;

      // 清 UI 状态，恢复生成中
      this.emitter.setInputHint(null);
      this.emitter.setInputType('freetext');
      this.emitter.setStatus('generating');

      // 显示玩家输入到叙事流
      this.emitter.appendEntry({ role: 'receive', content: text });

      // 记录到记忆
      const turn = this.stateStore.getTurn();
      await this.memory.appendTurn({
        turn,
        role: 'receive',
        content: text,
        tokenCount: estimateTokens(text),
      });

      // 🔭 可观测性：在当前 trace 上记录 player_input 事件
      this.currentTraceHandle?.event('player_input', { text }, { via: 'signal', turn });

      // 持久化：把玩家输入写入 narrative_entries，并清理输入状态。
      // 这个分支之前漏掉了持久化，导致挂起模式下的玩家消息重启后丢失。
      const memSnap = await this.memory.snapshot();
      this.persistence?.onReceiveComplete({
        entry: { role: 'receive', content: text },
        stateVars: this.stateStore.getAll(),
        turn,
        memoryEntries: memSnap.entries as unknown[],
        memorySummaries: (memSnap.summaries as string[]) ?? [],
      }).catch((e) => console.error('[Persistence] onReceiveComplete (signal) failed:', e));

      // resolve → agentic loop 继续
      resolve(text);
    } else if (this.inputResolve) {
      // 外循环 Receive 阶段
      this.inputResolve(text);
      this.inputResolve = null;
    }
  }

  /** Stop the session */
  stop(): void {
    this.active = false;

    // 中断进行中的 generate()
    this.abortController?.abort();
    this.abortController = null;

    // resolve 所有 pending Promise（防挂死）
    if (this.signalInputResolve) {
      this.signalInputResolve('');
      this.signalInputResolve = null;
    }
    if (this.inputResolve) {
      this.inputResolve('');
      this.inputResolve = null;
    }

    this.emitter.setStatus('idle');
  }

  // ============================================================================
  // Core Loop — Generate + Receive
  // ============================================================================

  private async coreLoop(): Promise<void> {
    while (this.active) {
      // --- Generate Phase ---
      this.emitter.setStatus('generating');
      const turn = this.stateStore.getTurn() + 1;
      this.stateStore.setTurn(turn);

      // ① 持久化：generate 开始
      await this.persistence?.onGenerateStart(turn).catch((e) =>
        console.error('[Persistence] onGenerateStart failed:', e));

      // 🔭 可观测性：为这一轮 generate 开启 trace（在 try 外层定义，catch 也能访问）
      const traceHandle: GenerateTraceHandle | undefined = this.tracing?.startGenerateTrace(turn);
      this.currentTraceHandle = traceHandle;
      const toolCallStack = new Map<string, ToolCallTraceHandle[]>();

      try {
        // Create tools with suspend-mode waitForPlayerInput
        const allTools = createTools({
          stateStore: this.stateStore,
          memory: this.memory,
          segments: this.segments,
          waitForPlayerInput: this.createWaitForPlayerInput(),
          onSetMood: (_mood) => {
            // TODO: connect to UI mood system
          },
          onScenarioEnd: (reason) => {
            // 只记下 flag；实际的"退出循环 + 持久化"在本轮 generate 返回后做。
            // 这样 LLM 在 end_scenario 之后还能继续输出一小段收尾文字再 stop。
            this.scenarioEnded = true;
            this.scenarioEndReason = reason;
          },
          onSceneChange: (patch) => {
            // M3 Part D 会在这里把 patch 应用到 this.currentScene 并
            // 通过 emitter 推给前端。现在只记录调用，保证 tsc 通过。
            this.applyScenePatch(patch);
          },
        });
        const enabledToolSet = getEnabledTools(allTools, this.enabledTools);

        // Assemble context
        const context = await assembleContext({
          segments: this.segments,
          stateStore: this.stateStore,
          memory: this.memory,
          tokenBudget: this.tokenBudget,
          initialPrompt: this.initialPrompt,
          currentQuery: await this.buildRetrievalQuery(),
          assemblyOrder: this.assemblyOrder,
          disabledSections: this.disabledSections,
        });

        // Compute active segment IDs
        const activeSegmentIds = this.segments
          .filter((s) => {
            if (!s.injectionRule) return true;
            try {
              const vars = this.stateStore.getAll();
              const keys = Object.keys(vars);
              const values = keys.map((k) => vars[k]);
              const fn = new Function(...keys, `try { return !!(${s.injectionRule.condition}); } catch { return false; }`);
              return fn(...values);
            } catch { return false; }
          })
          .map((s) => s.id);

        // Update global debug state
        this.emitter.updateDebug({
          tokenBreakdown: context.tokenBreakdown,
          assembledSystemPrompt: context.systemPrompt,
          assembledMessages: context.messages.map((m) => ({ role: m.role, content: m.content })),
          activeSegmentIds,
        });

        // Stage prompt snapshot for this generation entry
        this.emitter.stagePendingDebug({
          promptSnapshot: {
            systemPrompt: context.systemPrompt,
            messages: context.messages.map((m) => ({ role: m.role, content: m.content })),
            tokenBreakdown: context.tokenBreakdown,
            activeSegmentIds,
          },
        });

        // Create abort controller for this generate() call
        this.abortController = new AbortController();

        // 创建 streaming entry（文本将直接追加到这条 entry）
        this.currentNarrativeBuffer = '';
        this.emitter.beginStreamingEntry();

        // 🔭 可观测性：设置 trace 初始上下文（展示 LLM 看到的 prompt）
        traceHandle?.setInput({
          systemPrompt: context.systemPrompt,
          messages: context.messages.map((m) => ({ role: m.role, content: m.content })),
        });

        // M3: 为本轮创建 XML-lite Narrative Parser
        // Parser 从 text-delta 流里解析出结构化 Sentence[]，与旧的
        // entries[] 机制并存（M1 做 VN UI 时消费 Sentence[]）。
        let turnSentenceIndex = 0;
        const emitSentenceFrom = (
          partial:
            | { kind: 'narration'; text: string }
            | { kind: 'dialogue'; text: string; pf: ParticipationFrame; truncated?: boolean }
            | { kind: 'scene_change'; scene: SceneState; transition?: 'fade' | 'cut' | 'dissolve' },
        ) => {
          const base = { turnNumber: turn, index: turnSentenceIndex++ };
          let sentence: Sentence;
          if (partial.kind === 'narration') {
            sentence = { kind: 'narration', text: partial.text, sceneRef: { ...this.currentScene }, ...base };
          } else if (partial.kind === 'dialogue') {
            sentence = {
              kind: 'dialogue',
              text: partial.text,
              pf: partial.pf,
              sceneRef: { ...this.currentScene },
              ...base,
              ...(partial.truncated !== undefined ? { truncated: partial.truncated } : {}),
            };
          } else {
            sentence = {
              kind: 'scene_change',
              scene: partial.scene,
              ...(partial.transition !== undefined ? { transition: partial.transition } : {}),
              ...base,
            };
          }
          this.emitter.appendSentence(sentence);
        };

        const narrativeParser = new NarrativeParser({
          onNarrationChunk: (text) => {
            emitSentenceFrom({ kind: 'narration', text });
          },
          // onDialogueStart / onDialogueChunk 不单独 emit——等整段 end 一次性
          // emit Sentence（前端 VN 打字机从 Sentence 派生，无需子级 chunk 事件）
          onDialogueEnd: (pf, fullText, truncated) => {
            emitSentenceFrom({ kind: 'dialogue', text: fullText, pf, truncated });
            // 🔭 tracing: XML-lite 流被截断（未闭合 </d>）记 Langfuse 事件
            if (truncated) {
              traceHandle?.event(
                'narrative-truncation',
                { speaker: pf.speaker, partialLength: fullText.length },
                { turn, kind: 'dialogue' },
              );
            }
          },
        });
        // 把 applyScenePatch 包装一层：除了更新 this.currentScene，
        // 还要 emit scene-change 事件 + 产出一条 scene_change Sentence + Langfuse 事件
        this.scenePatchEmitter = (transition) => {
          this.emitter.emitSceneChange(this.currentScene, transition);
          emitSentenceFrom({ kind: 'scene_change', scene: { ...this.currentScene }, transition });
          traceHandle?.event(
            'scene-change',
            { scene: this.currentScene, transition },
            { turn },
          );
        };

        // Call LLM (agentic tool loop — signal_input_needed 会挂起等玩家)
        //
        // 推理/叙事分离由 AI SDK 原生通道处理：
        //   - text-delta 事件 → onTextChunk → 叙事正文
        //   - reasoning-delta 事件 → onReasoningChunk → 思考过程（仅 reasoner 类模型产生）
        // 不再做启发式过滤（见 scripts/verify-deepseek-reasoning.ts 的验证结论）
        const result = await this.llmClient.generate({
          systemPrompt: context.systemPrompt,
          messages: context.messages,
          tools: enabledToolSet,
          maxSteps: 30,
          // maxOutputTokens 默认从 LLMClient 的 config.maxOutputTokens 取（P2a 修复）
          abortSignal: this.abortController.signal,
          onTextChunk: (chunk) => {
            this.currentNarrativeBuffer += chunk;
            this.emitter.appendToStreamingEntry(chunk);
            // M3: 同步喂给 Narrative Parser 产出结构化 Sentence[]
            narrativeParser.push(chunk);
          },
          onReasoningChunk: (chunk) => {
            this.emitter.appendReasoningToStreamingEntry(chunk);
          },
          onToolCall: (name, args) => {
            this.emitter.addToolCall({ name, args, result: undefined });
            this.emitter.addPendingToolCall({ name, args, result: undefined });
            // 🔭 tracing: 开启 tool span
            const handle = traceHandle?.startToolCall(name, args);
            if (handle) {
              const stack = toolCallStack.get(name) ?? [];
              stack.push(handle);
              toolCallStack.set(name, stack);
            }
          },
          onToolResult: (name, toolResult) => {
            this.emitter.updateToolResult(name, toolResult);
            this.emitter.updatePendingToolResult(name, toolResult);
            // 🔭 tracing: 结束 tool span（FIFO 配对同名 call）
            const stack = toolCallStack.get(name);
            if (stack && stack.length > 0) {
              const handle = stack.shift();
              handle?.end(toolResult);
            }
          },
          onStep: (step) => {
            // 🔭 tracing: 每个 step 记一个 generation span
            traceHandle?.recordStep({
              stepNumber: step.stepNumber,
              text: step.text,
              reasoning: step.reasoning,
              finishReason: step.finishReason,
              inputTokens: step.inputTokens,
              outputTokens: step.outputTokens,
              model: step.model,
              partKinds: step.partKinds,
              responseTimestamp: step.responseTimestamp,
              stepInputMessages: step.stepInputMessages,
            });
          },
        });

        this.abortController = null;

        // M3: parser 末尾降级（把未闭合 <d> 当 truncated 结束）
        narrativeParser.finalize();
        this.scenePatchEmitter = null;

        // Stage finish reason
        this.emitter.stagePendingDebug({ finishReason: result.finishReason });

        // Finalize streaming → append to narrative entries (with attached debug info)
        this.emitter.finalizeStreamingEntry();

        // Store LLM response in memory.
        //
        // 注意：如果本轮 generate 内有 signal_input_needed，createWaitForPlayerInput
        // 已经把 signal 前的叙事段 append 进 memory 了。这里用 currentNarrativeBuffer
        // （只含 signal 后的增量文本）而不是 result.text（全量文本），避免重复。
        //
        // 没有 signal 的场景：currentNarrativeBuffer 就是全量文本，和 result.text 一样。
        if (this.currentNarrativeBuffer) {
          await this.memory.appendTurn({
            turn,
            role: 'generate',
            content: this.currentNarrativeBuffer,
            tokenCount: estimateTokens(this.currentNarrativeBuffer),
          });
        }

        // ② 持久化：最后一段 streaming entry（generate 自然返回后）
        //    注：如果中间有 signal_input_needed 挂起，那些段已在 createWaitForPlayerInput 中持久化过了
        if (this.currentNarrativeBuffer) {
          await this.persistence?.onNarrativeSegmentFinalized({
            entry: {
              role: 'generate',
              content: this.currentNarrativeBuffer,
              finishReason: result.finishReason,
            },
          }).catch((e) => console.error('[Persistence] onNarrativeSegmentFinalized (final) failed:', e));
          this.currentNarrativeBuffer = '';
        }

        // 同步 memory 快照和 preview
        const memSnapGen = await this.memory.snapshot();
        await this.persistence?.onGenerateComplete({
          memoryEntries: memSnapGen.entries as unknown[],
          memorySummaries: (memSnapGen.summaries as string[]) ?? [],
          preview: result.text ? result.text.slice(0, 80).replace(/\n/g, ' ') : null,
          // M3: 持久化 VN 当前场景，断线重连时可恢复视觉状态
          currentScene: this.currentScene,
        }).catch((e) => console.error('[Persistence] onGenerateComplete failed:', e));

        // 让 adapter 自己决定是否真压缩：legacy 查 token 阈值、mem0 批量 flush 等。
        // 状态 bar 仅在 legacy/LLMSummarizer 真的跑压缩时切到 'compressing' 比较准，
        // 目前简化：调用前先切，无操作也不伤害。
        this.emitter.setStatus('compressing');
        await this.memory.maybeCompact();

        // Sync debug state
        await this.syncDebugState();

        // 🔭 可观测性：结束这一轮 trace
        traceHandle?.end({ text: result.text, finishReason: result.finishReason });

      } catch (error) {
        if (!this.active) break;
        // Finalize any partial streaming content so it's not lost
        this.emitter.finalizeStreamingEntry();
        // 🔭 可观测性：记录错误到当前 trace
        traceHandle?.error(
          error instanceof Error ? error.message : String(error),
          'generate',
        );
        traceHandle?.end({ error: String(error) });
        // Show error banner but don't change status — Receive Phase will set waiting-input
        this.emitter.setError(error instanceof Error ? error.message : String(error));
        // Fall through to Receive Phase — player can re-send to retry
      } finally {
        this.currentTraceHandle = undefined;
      }

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

      // --- Receive Phase (fallback) ---
      // LLM 自然停止后（没有通过 signal_input_needed 请求输入），等玩家输入再开始下一轮。
      // 如果 LLM 在 generate 过程中已经通过 signal_input_needed 获取了玩家输入，
      // 这里仍然需要等——因为 LLM 停下意味着这一轮叙事结束了，需要玩家推动下一轮。
      if (this.active) {
        this.emitter.setStatus('waiting-input');

        // ③ 持久化：进入等待输入（外循环 receive phase）
        // 同样保存 memoryEntries，断线重连时不丢失
        const memSnapWait = await this.memory.snapshot();
        await this.persistence?.onWaitingInput({
          hint: null,
          inputType: 'freetext',
          choices: null,
          memoryEntries: memSnapWait.entries as unknown[],
          memorySummaries: (memSnapWait.summaries as string[]) ?? [],
        }).catch((e) => console.error('[Persistence] onWaitingInput failed:', e));

        const inputText = await this.waitForInput();

        if (!this.active) break; // stopped while waiting

        // Clear error banner on new input
        this.emitter.setError(null);

        if (inputText) {
          this.emitter.appendEntry({ role: 'receive', content: inputText });

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
            memoryEntries: memSnapRx.entries as unknown[],
            memorySummaries: (memSnapRx.summaries as string[]) ?? [],
          }).catch((e) => console.error('[Persistence] onReceiveComplete failed:', e));
        }

        this.emitter.setInputHint(null);
        this.emitter.setInputType('freetext');
      }
    }
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /**
   * 为本轮 generate 构造 Memory.retrieve 的 query。
   *
   * Phase 1 版本：直接返回最近一次玩家输入（submitInput 时写入的 lastPlayerInput）。
   *
   * ⚠ 这里**故意**留一个扩展点。未来可能升级为：
   *   - 用便宜 LLM 根据当前 state + 最近 N 轮叙事生成检索 query
   *   - 拼接 state 里关键变量（角色名、场景、物品）作为 query
   *   - 多 query 并行 retrieve 合并结果
   *
   * 升级时只改这个函数，assembleContext / Memory.retrieve 完全不动。
   *
   * **不要**把这个生成逻辑内联到 assembleContext 调用处 —— 扩展点的
   * 价值就是"一个函数管所有 query 策略"。
   *
   * 空字符串合法：adapter 按契约兜底（legacy → entries 空数组；mem0 按策略）。
   */
  private async buildRetrievalQuery(): Promise<string> {
    return this.lastPlayerInput;
  }

  /** 创建 waitForPlayerInput 回调，供 signal_input_needed 的 execute 使用 */
  private createWaitForPlayerInput(): (options: SignalInputOptions) => Promise<string> {
    return async (options: SignalInputOptions) => {
      // ★ 挂起前把当前叙事段同时写入两个地方：
      //   1. narrative_entries 表（DB 叙事记录，供 UI 恢复显示）
      //   2. MemoryManager entries（供下一次 assembleContext 拿 recent history）
      //
      // 为什么两个都要：
      //   - onNarrativeSegmentFinalized 只写 narrative_entries，不写 memory_entries
      //   - memory.appendTurn 只改内存，不写 DB
      //   - generate() 返回后的 memory.appendTurn(result.text) 会包含 ALL text，
      //     但在 signal 挂起期间 generate() 还没返回，memory 里看不到本段叙事。
      //     如果此时断线重连，memory 就是空的 → LLM 没有 recent history。
      //
      // 为了避免 generate() 返回后重复 append 整段 text，这里 append 后设
      // 标记，post-generate 只 append 剩余的新增部分。
      if (this.currentNarrativeBuffer) {
        // 写 narrative_entries（UI 显示用）
        await this.persistence?.onNarrativeSegmentFinalized({
          entry: {
            role: 'generate',
            content: this.currentNarrativeBuffer,
          },
        }).catch((e) =>
          console.error('[Persistence] onNarrativeSegmentFinalized (signal) failed:', e),
        );
        // 写 memory（LLM context 用）
        await this.memory.appendTurn({
          turn: this.stateStore.getTurn(),
          role: 'generate',
          content: this.currentNarrativeBuffer,
          tokenCount: estimateTokens(this.currentNarrativeBuffer),
        });
        this.currentNarrativeBuffer = '';
      }

      // 将当前 streaming entry 标记为完成
      this.emitter.finalizeStreamingEntry();

      // 更新 UI：显示选项和提示
      this.emitter.setInputHint(options.hint ?? null);
      if (options.choices && options.choices.length > 0) {
        this.emitter.setInputType('choice', options.choices);
      }
      this.emitter.setStatus('waiting-input');

      // ③ 持久化：signal_input_needed 触发的等待输入
      // 同时保存最新的 memoryEntries 快照 → 断线重连后 memory 不空
      const memSnapSignal = await this.memory.snapshot();
      await this.persistence?.onWaitingInput({
        hint: options.hint ?? null,
        inputType: options.choices?.length ? 'choice' : 'freetext',
        choices: options.choices ?? null,
        memoryEntries: memSnapSignal.entries as unknown[],
        memorySummaries: (memSnapSignal.summaries as string[]) ?? [],
      }).catch((e) => console.error('[Persistence] onWaitingInput (signal) failed:', e));

      // 返回挂起 Promise，等 submitInput() 调用时 resolve
      return new Promise<string>((resolve) => {
        this.signalInputResolve = (text: string) => {
          // 玩家输入后，开始新的 streaming entry 接收 LLM 后续输出
          this.currentNarrativeBuffer = '';
          this.emitter.beginStreamingEntry();
          resolve(text);
        };
      });
    };
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

  /**
   * M3: 应用 change_scene / change_sprite / clear_stage 工具产生的 scene patch。
   * 步骤：
   *   1. 更新 this.currentScene
   *   2. 通过 scenePatchEmitter（由 generate() 装载）emit WS 事件 + Sentence
   *   3. onGenerateComplete 时把 currentScene 持久化到 DB
   */
  private applyScenePatch(patch: import('./tool-executor').ScenePatch): void {
    let transition: 'fade' | 'cut' | 'dissolve' | undefined;

    if (patch.kind === 'clear') {
      this.currentScene = { background: null, sprites: [] };
    } else if (patch.kind === 'full') {
      this.currentScene = {
        background: patch.background !== undefined ? patch.background : this.currentScene.background,
        sprites: patch.sprites !== undefined ? patch.sprites : this.currentScene.sprites,
      };
      transition = patch.transition;
    } else if (patch.kind === 'single-sprite') {
      // 替换同 id 的 sprite，否则追加
      const existing = this.currentScene.sprites.findIndex((s) => s.id === patch.sprite.id);
      const nextSprites = [...this.currentScene.sprites];
      if (existing >= 0) {
        nextSprites[existing] = patch.sprite;
      } else {
        nextSprites.push(patch.sprite);
      }
      this.currentScene = { ...this.currentScene, sprites: nextSprites };
    }

    this.scenePatchEmitter?.(transition);
  }
}
