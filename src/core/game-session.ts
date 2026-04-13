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
import { MemoryManager, estimateTokens } from './memory';
import { assembleContext } from './context-assembler';
import { createTools, getEnabledTools } from './tool-executor';
import type { SignalInputOptions } from './tool-executor';
import { LLMClient } from './llm-client';
import type { LLMConfig } from './llm-client';
import type { SessionEmitter } from './session-emitter';

// ============================================================================
// ReasoningFilter — 启发式分离 LLM 推理文本与叙事正文
// ============================================================================

/**
 * 某些模型（如 deepseek-chat）将推理过程直接输出到 content 中，
 * 而非通过 reasoning_content 字段。此过滤器在流式输出中检测并分离推理文本。
 *
 * 策略：缓冲初始文本，检测到叙事起始标记后，将缓冲内容分类为 reasoning，
 * 后续内容直接作为叙事正文传递。
 */
class ReasoningFilter {
  private buffer = '';
  private resolved = false; // true = 已确定推理/正文边界
  private onReasoning: (text: string) => void;
  private onText: (text: string) => void;

  /** 叙事正文的起始标记（出现任一即认为正文开始） */
  private static NARRATIVE_MARKERS = /\n---[\s\n]|\n#{1,3}\s|\n\*\*/;

  constructor(
    onReasoning: (text: string) => void,
    onText: (text: string) => void,
  ) {
    this.onReasoning = onReasoning;
    this.onText = onText;
  }

  push(chunk: string): void {
    if (this.resolved) {
      // 边界已确定，直接传递正文
      this.onText(chunk);
      return;
    }

    this.buffer += chunk;

    // 检测叙事标记
    const match = ReasoningFilter.NARRATIVE_MARKERS.exec(this.buffer);
    if (match) {
      // 标记前的内容是推理，标记及之后是正文
      const reasoningPart = this.buffer.slice(0, match.index).trim();
      const narrativePart = this.buffer.slice(match.index);

      if (reasoningPart) {
        this.onReasoning(reasoningPart);
      }
      this.onText(narrativePart);
      this.resolved = true;
      return;
    }

    // 缓冲超过 500 字符仍无标记 → 认为全是正文（无推理前缀）
    if (this.buffer.length > 500) {
      this.onText(this.buffer);
      this.resolved = true;
    }
  }

  /** 流结束时 flush 剩余缓冲 */
  flush(): void {
    if (!this.resolved && this.buffer) {
      // 从未检测到标记，全部视为正文
      this.onText(this.buffer);
      this.resolved = true;
    }
  }
}

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

  /** generate() 全部结束后同步 memory 快照 + preview（不再负责 entry 入库） */
  onGenerateComplete(data: {
    memoryEntries: unknown[];
    memorySummaries: string[];
    preview?: string | null;
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
  memoryEntries: unknown[];       // MemoryEntry[] from DB (JSONB)
  memorySummaries: string[];
  status: string;                 // 恢复时的状态
  inputHint?: string | null;
  inputType?: string;
  choices?: string[] | null;
}

export interface GameSessionConfig {
  chapterId: string;
  segments: PromptSegment[];
  stateSchema: StateSchema;
  memoryConfig: MemoryConfig;
  llmConfig: LLMConfig;
  enabledTools?: string[];       // optional tool names to enable
  tokenBudget?: number;          // context window budget (default: 120000)
  inheritedSummary?: string;     // from previous chapter
  initialPrompt?: string;        // 首轮 user message（等效于 prompt.txt）
  assemblyOrder?: string[];      // 自定义 prompt 组装顺序
  disabledSections?: string[];   // 被禁用的 section ID 列表
  persistence?: SessionPersistence;  // 可选持久化（远程模式写 DB）
  tracing?: SessionTracing;          // 可选可观测性（远程模式接 Langfuse）
}

// ============================================================================
// GameSession
// ============================================================================

export class GameSession {
  private emitter: SessionEmitter;

  private stateStore!: StateStore;
  private memory!: MemoryManager;
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

  // 外循环 Receive 阶段的挂起 Promise（LLM 自然停止后等玩家输入）
  private inputResolve: ((text: string) => void) | null = null;

  // 内循环挂起 Promise（signal_input_needed 等玩家输入）
  private signalInputResolve: ((text: string) => void) | null = null;

  // 用于中断进行中的 generate()（停止/重置时防挂死）
  private abortController: AbortController | null = null;

  // ReasoningFilter flush 回调：signal_input_needed 触发时需要先 flush 缓冲区
  private flushTextFilter: (() => void) | null = null;

  // Compress function for memory
  private compressFn = async (entries: import('./types').MemoryEntry[]): Promise<string> => {
    // Simple concatenation fallback — in production, this would use LLM
    return entries
      .map((e) => `[${e.role}] ${e.content.slice(0, 200)}`)
      .join('\n');
  };

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
      this.memory = new MemoryManager(config.memoryConfig);
      this.llmClient = new LLMClient(config.llmConfig);
      this.segments = config.segments;
      this.enabledTools = config.enabledTools ?? [];
      this.tokenBudget = config.tokenBudget ?? 120000;
      this.initialPrompt = config.initialPrompt;
      this.assemblyOrder = config.assemblyOrder;
      this.disabledSections = config.disabledSections;
      this.persistence = config.persistence;
      this.tracing = config.tracing;

      if (config.inheritedSummary) {
        this.memory.setInheritedSummary(config.inheritedSummary);
      }

      // Sync initial state to UI
      this.syncDebugState();

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
      this.memory = new MemoryManager(config.memoryConfig);
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
      this.memory.restore(
        config.memoryEntries as import('./types').MemoryEntry[],
        config.memorySummaries,
      );

      // 同步 UI
      this.syncDebugState();

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
          this.memory.appendTurn({
            turn: config.turn,
            role: 'receive',
            content: inputText,
            tokenCount: estimateTokens(inputText),
          });
          await this.persistence?.onReceiveComplete({
            entry: { role: 'receive', content: inputText },
            stateVars: this.stateStore.getAll(),
            turn: config.turn,
            memoryEntries: this.memory.getAllEntries(),
            memorySummaries: this.memory.getSummaries(),
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
  submitInput(text: string): void {
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
      this.memory.appendTurn({
        turn,
        role: 'receive',
        content: text,
        tokenCount: estimateTokens(text),
      });

      // 🔭 可观测性：在当前 trace 上记录 player_input 事件
      this.currentTraceHandle?.event('player_input', { text }, { via: 'signal', turn });

      // 持久化：把玩家输入写入 narrative_entries，并清理输入状态。
      // 这个分支之前漏掉了持久化，导致挂起模式下的玩家消息重启后丢失。
      this.persistence?.onReceiveComplete({
        entry: { role: 'receive', content: text },
        stateVars: this.stateStore.getAll(),
        turn,
        memoryEntries: this.memory.getAllEntries(),
        memorySummaries: this.memory.getSummaries(),
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
          onShowImage: (_assetId) => {
            // TODO: connect to UI image display
          },
          onScenarioEnd: (reason) => {
            // 只记下 flag；实际的"退出循环 + 持久化"在本轮 generate 返回后做。
            // 这样 LLM 在 end_scenario 之后还能继续输出一小段收尾文字再 stop。
            this.scenarioEnded = true;
            this.scenarioEndReason = reason;
          },
        });
        const enabledToolSet = getEnabledTools(allTools, this.enabledTools);

        // Assemble context
        const context = assembleContext({
          segments: this.segments,
          stateStore: this.stateStore,
          memory: this.memory,
          tokenBudget: this.tokenBudget,
          initialPrompt: this.initialPrompt,
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

        // Call LLM (agentic tool loop — signal_input_needed 会挂起等玩家)
        //
        // 推理过滤策略：
        // 1. 有原生思考（thinkingEnabled）→ 跳过，text-delta 是纯叙事
        // 2. 无原生思考 + reasoningFilterEnabled → 启发式分离推理/叙事
        // 3. 无原生思考 + !reasoningFilterEnabled → 跳过，全部当叙事
        const hasNativeReasoning = this.llmClient.isThinkingEnabled();
        const useFilter = !hasNativeReasoning && this.llmClient.isReasoningFilterEnabled();

        const textFilter = useFilter ? new ReasoningFilter(
          (reasoning) => this.emitter.appendReasoningToStreamingEntry(reasoning),
          (text) => {
            this.currentNarrativeBuffer += text;
            this.emitter.appendToStreamingEntry(text);
          },
        ) : null;
        // 存 flush 引用，供 createWaitForPlayerInput() 在挂起前刷出缓冲文本
        this.flushTextFilter = textFilter ? () => textFilter.flush() : null;
        const result = await this.llmClient.generate({
          systemPrompt: context.systemPrompt,
          messages: context.messages,
          tools: enabledToolSet,
          maxSteps: 30,
          abortSignal: this.abortController.signal,
          onTextChunk: (chunk) => {
            if (textFilter) {
              textFilter.push(chunk);
            } else {
              // 原生思考模式：text-delta 直接作为叙事正文
              this.currentNarrativeBuffer += chunk;
              this.emitter.appendToStreamingEntry(chunk);
            }
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

        // Flush any buffered text in the reasoning filter
        textFilter?.flush();

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
          this.memory.appendTurn({
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
        await this.persistence?.onGenerateComplete({
          memoryEntries: this.memory.getAllEntries(),
          memorySummaries: this.memory.getSummaries(),
          preview: result.text ? result.text.slice(0, 80).replace(/\n/g, ' ') : null,
        }).catch((e) => console.error('[Persistence] onGenerateComplete failed:', e));

        // Check if memory needs compression
        if (this.memory.needsCompression()) {
          this.emitter.setStatus('compressing');
          await this.memory.compress(this.compressFn);
        }

        // Sync debug state
        this.syncDebugState();

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
        await this.persistence?.onWaitingInput({
          hint: null,
          inputType: 'freetext',
          choices: null,
          memoryEntries: this.memory.getAllEntries(),
          memorySummaries: this.memory.getSummaries(),
        }).catch((e) => console.error('[Persistence] onWaitingInput failed:', e));

        const inputText = await this.waitForInput();

        if (!this.active) break; // stopped while waiting

        // Clear error banner on new input
        this.emitter.setError(null);

        if (inputText) {
          this.emitter.appendEntry({ role: 'receive', content: inputText });

          this.memory.appendTurn({
            turn,
            role: 'receive',
            content: inputText,
            tokenCount: estimateTokens(inputText),
          });

          // ④ 持久化：receive 完成
          await this.persistence?.onReceiveComplete({
            entry: { role: 'receive', content: inputText },
            stateVars: this.stateStore.getAll(),
            turn,
            memoryEntries: this.memory.getAllEntries(),
            memorySummaries: this.memory.getSummaries(),
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

  /** 创建 waitForPlayerInput 回调，供 signal_input_needed 的 execute 使用 */
  private createWaitForPlayerInput(): (options: SignalInputOptions) => Promise<string> {
    return async (options: SignalInputOptions) => {
      // 先 flush ReasoningFilter 缓冲区，确保所有文本都写进 streaming entry
      this.flushTextFilter?.();

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
        this.memory.appendTurn({
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
      await this.persistence?.onWaitingInput({
        hint: options.hint ?? null,
        inputType: options.choices?.length ? 'choice' : 'freetext',
        choices: options.choices ?? null,
        memoryEntries: this.memory.getAllEntries(),
        memorySummaries: this.memory.getSummaries(),
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

  private syncDebugState(): void {
    this.emitter.updateDebug({
      stateVars: this.stateStore.getAll(),
      totalTurns: this.stateStore.getTurn(),
      memoryEntryCount: this.memory.getAllEntries().length,
      memorySummaryCount: this.memory.getSummaries().length,
    });
  }
}
