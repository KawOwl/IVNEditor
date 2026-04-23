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
import { computeFocus } from './focus';
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

// ============================================================================
// 旁白 Sentence 切分策略
// ============================================================================

/**
 * 一段连续旁白里下一个切分点。VN UI 对一条 Sentence 一屏打字机的粒度敏感：
 *   - 太大：玩家读一段要等很久、也不好 backlog 翻页
 *   - 太小：点击推进变得碎
 *
 * 切分优先级（从高到低）：
 *   1. `\n\n` —— 作者 / 模型自然的段落边界
 *   2. 超过 MAX 软阈值 + 找到句末标点（。！？.!?）—— 长段落按句分
 *   3. 超过 HARD 硬上限 + 找到任意收束字符（。！？.!? ， ；\n 空格）—— 兜底
 *   4. 没找到合适切点 → 返回 null，留给后续 chunk / finalize
 *
 * 返回：
 *   - `null` 表示现在不切，继续累积
 *   - `{ end, consume }`：`end` = Sentence 文本结束下标（exclusive，切出 [0, end) 作 Sentence）；
 *                         `consume` = 从 buffer 丢掉的长度（= end + 分隔符长度）
 */
export const NARRATION_SOFT_LIMIT = 400;   // 超过这个长度开始找句末标点切
export const NARRATION_HARD_LIMIT = 800;   // 超过这个长度必须切（找不到句末也切）

// 导出以便 unit test 单独测。生产代码只在 game-session 内部用。
export function findNarrationCut(buf: string): { end: number; consume: number } | null {
  // 1. \n\n 段落边界
  const paraIdx = buf.indexOf('\n\n');
  if (paraIdx >= 0) {
    return { end: paraIdx, consume: paraIdx + 2 };
  }
  // 2. 软阈值 + 句末标点（中英文 。！？.!?）
  if (buf.length > NARRATION_SOFT_LIMIT) {
    // 从软阈值 * 0.7 位置开始往后找第一个句末
    const searchFrom = Math.floor(NARRATION_SOFT_LIMIT * 0.7);
    const sentIdx = findSentenceEnd(buf, searchFrom);
    if (sentIdx >= 0) {
      return { end: sentIdx + 1, consume: sentIdx + 1 };
    }
  }
  // 3. 硬上限兜底：从 0 位置找任意收束字符
  if (buf.length > NARRATION_HARD_LIMIT) {
    const weakIdx = findWeakBreak(buf, Math.floor(NARRATION_HARD_LIMIT * 0.7));
    if (weakIdx >= 0) {
      return { end: weakIdx + 1, consume: weakIdx + 1 };
    }
    // 真·没标点（理论上不应该发生）→ 硬切在 HARD 上
    return { end: NARRATION_HARD_LIMIT, consume: NARRATION_HARD_LIMIT };
  }
  return null;
}

/** 从 from 开始找第一个句末标点的下标；没找到返回 -1。 */
function findSentenceEnd(buf: string, from: number): number {
  for (let i = from; i < buf.length; i++) {
    const ch = buf[i];
    if (ch === '。' || ch === '！' || ch === '？' || ch === '.' || ch === '!' || ch === '?') {
      return i;
    }
  }
  return -1;
}

/** 找任意收束字符（句末/逗号/分号/换行/空格）的下标；没找到返回 -1。 */
function findWeakBreak(buf: string, from: number): number {
  for (let i = from; i < buf.length; i++) {
    const ch = buf[i];
    if (ch === '。' || ch === '！' || ch === '？' || ch === '.' || ch === '!' || ch === '?'
        || ch === '，' || ch === '；' || ch === ',' || ch === ';' || ch === '\n' || ch === ' ') {
      return i;
    }
  }
  return -1;
}

/**
 * 旁白累积器 —— 把 NarrativeParser 的 onNarrationChunk 回调攒成段落级 Sentence。
 *
 * 作为可独立测试的纯函数抽出来。生产代码在 generate() 闭包里用 emit 回调
 * 直接发 Sentence；测试代码可以塞个 array 收发出的段落、断言切分粒度。
 *
 * 用法：
 *   const acc = createNarrationAccumulator((para) => emitSentenceFrom(...));
 *   parser.onNarrationChunk = acc.push;
 *   // 在 signal 挂起 / scene change / generate 结束时：
 *   acc.flush();
 */
export function createNarrationAccumulator(emit: (para: string) => void) {
  let buf = '';
  return {
    /** 把一个 chunk 塞进累积器，尽可能切出完整段落并 emit */
    push(text: string): void {
      buf += text;
      while (true) {
        const cut = findNarrationCut(buf);
        if (cut === null) break;
        const para = buf.slice(0, cut.end).trim();
        if (para) emit(para);
        buf = buf.slice(cut.consume);
      }
    },
    /** 把剩余的 buffer 全部 emit（段落边界不在末尾时） */
    flush(): void {
      const trimmed = buf.trim();
      if (trimmed) emit(trimmed);
      buf = '';
    },
    /** 诊断：当前剩余 buffer 长度 */
    pending(): number {
      return buf.length;
    },
  };
}

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
    entry: { role: string; content: string; reasoning?: string; finishReason?: string };
  }): Promise<void>;

  /** generate() 全部结束后同步 memory 快照 + preview + VN 场景（不再负责 entry 入库） */
  onGenerateComplete(data: {
    /** Memory adapter 自 snapshot() 的 opaque JSON（legacy-v1 / mem0-v1 / ...） */
    memorySnapshot: Record<string, unknown>;
    preview?: string | null;
    /** M3: VN 当前场景快照，持久化到 playthroughs.current_scene */
    currentScene?: SceneState | null;
  }): Promise<void>;

  /** 进入等待输入状态（signal_input_needed 或外循环 receive phase） */
  onWaitingInput(data: {
    hint: string | null;
    inputType: string;
    choices: string[] | null;
    /** signal 路径传 memory snapshot，让断线重连后 history 不丢 */
    memorySnapshot?: Record<string, unknown>;
    /**
     * M3: VN 当前场景快照。signal_input_needed 路径下 generate() 还没返回，
     * onGenerateComplete 不会触发；挂起前同步持久化 currentScene，
     * 否则断线重连时 VN 无 background / sprites，看上去像空舞台。
     */
    currentScene?: SceneState | null;
  }): Promise<void>;

  /** 玩家输入完成 */
  onReceiveComplete(data: {
    entry: { role: string; content: string };
    stateVars: Record<string, unknown>;
    turn: number;
    memorySnapshot: Record<string, unknown>;
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
     * tracing 层把它作为 generation span 的 endTime（TTFT 终点），避免被
     * signal_input_needed 挂起污染（见 StepInfo 字段注释）。
     */
    responseTimestamp?: Date;
    /**
     * 该 step 送给 provider 之前的瞬间（experimental_onStepStart 时刻）。
     * tracing 层用作 generation span 的 startTime。
     */
    stepStartAt?: Date;
    /**
     * 该 step 发给 LLM 的完整 messages 简化版。
     * tracing 层写进 generation span 的 input，替代初始的 this.initialInput。
     */
    stepInputMessages?: Array<{ role: string; content: string }>;
    /**
     * 该 step 实际发给 LLM 的 system prompt（Focus Injection D 后必需）。
     * tracing 层用这个替换 initialInput.systemPrompt 的开局快照，
     * 让 Langfuse UI 里每 step 的 input.system 反映真实内容。
     */
    effectiveSystemPrompt?: string;
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
  /**
   * Memory adapter 的 opaque snapshot（从 playthroughs.memory_snapshot 直接读）。
   * 为 null（初次游玩）时传 null，Memory.restore 自己兜底空状态。
   */
  memorySnapshot: Record<string, unknown> | null;
  status: string;                 // 恢复时的状态
  inputHint?: string | null;
  inputType?: string;
  choices?: string[] | null;
  /** VN 当前场景快照（M3）。null = 老 playthrough，取 manifest.defaultScene 或空。 */
  currentScene?: SceneState | null;
  /** 场景默认值，当没有 currentScene 快照时用 */
  defaultScene?: SceneState;
  /** mem0 adapter 的 API key —— server 从 env 读后注入 */
  mem0ApiKey?: string;
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
  /** mem0 adapter 的 API key —— server 从 env 读后注入（前端不读 env） */
  mem0ApiKey?: string;
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

  /**
   * 把 generate() 内部 narration 累积 buffer 刷出去。
   * signal_input_needed 挂起前 createWaitForPlayerInput 调这个，确保玩家在
   * 看到选项之前先看到最新的旁白 Sentence。generate() 执行期间非 null。
   */
  private pendingNarrationFlusher: (() => void) | null = null;

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
      // LLMClient 先于 Memory 创建 —— llm-summarizer adapter 构造时要
      // 注入 llmClient 做 compressFn，所以顺序不能再像之前那样 memory 在前。
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
      });
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
      // LLMClient 先于 Memory 创建（llm-summarizer adapter 需要）
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
      });
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

      // 同步 UI
      await this.syncDebugState();

      // 可观测性：恢复标记，方便 Langfuse UI 中识别"断点"
      this.tracing?.markSessionRestored(config.turn, {
        status: config.status,
        hasSnapshot: config.memorySnapshot !== null,
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
          this.emitPlayerInputSentence(inputText);
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

      // 显示玩家输入到叙事流（legacy entries channel + VN Sentence channel）
      this.emitter.appendEntry({ role: 'receive', content: text });
      this.emitPlayerInputSentence(text);

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
        memorySnapshot: memSnap,
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

        // Assemble context —— 抽成闭包，让 prepareStep hook 里也能按当前 state 重调。
        //
        // Focus Injection D：一次 generate() 可以跨多个 scene 切换（signal_input_needed
        // 挂起期间 state.current_scene 可能变化），外层 assembleContext 只在开头跑一次
        // 拿到的是初始 focus 对应的 prompt。为了让后续 step 能看到新 scene 的 segment，
        // prepareStep 里会在 focus 变化时调这个闭包重新 assemble。
        const runAssemble = async (focus: ReturnType<typeof computeFocus>) => {
          return assembleContext({
            segments: this.segments,
            stateStore: this.stateStore,
            memory: this.memory,
            tokenBudget: this.tokenBudget,
            initialPrompt: this.initialPrompt,
            currentQuery: await this.buildRetrievalQuery(),
            focus,
            assemblyOrder: this.assemblyOrder,
            disabledSections: this.disabledSections,
          });
        };

        let focus = computeFocus(this.stateStore.getAll());
        let context = await runAssemble(focus);

        // prepareStep 缓存：同一个 focus key 不反复跑 assembleContext，避免无谓的
        // memory.retrieve + prompt cache miss。只有 focus 真的变了才重算。
        const focusKey = (f: ReturnType<typeof computeFocus>) =>
          JSON.stringify({ scene: f.scene, characters: f.characters, stage: f.stage });
        let cachedFocusKey = focusKey(focus);
        let cachedSystemPrompt = context.systemPrompt;

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

        // Narration 跨 chunk 累积器：
        //   parser 的 onNarrationChunk 按 chunk 粒度来；游戏 UI 需要段落粒度。
        //   createNarrationAccumulator 把 chunk 攒起来，遇到段落边界 / 字数阈值
        //   时 emit 成一条 narration Sentence。在 dialogue 开始 / 场景切换 /
        //   signal 挂起 / generate 结束这些"叙事切换点"调 flush 把残余吐出。
        const narrationAcc = createNarrationAccumulator((para) =>
          emitSentenceFrom({ kind: 'narration', text: para }),
        );
        const flushPendingNarration = () => narrationAcc.flush();

        const narrativeParser = new NarrativeParser({
          onNarrationChunk: (text) => narrationAcc.push(text),
          onDialogueStart: () => {
            // 对话开始前把未出口的 narration 先 emit 掉，保证顺序
            flushPendingNarration();
          },
          // onDialogueChunk 不单独 emit——等整段 end 一次性 emit Sentence
          // （前端 VN 打字机从 Sentence 派生，无需子级 chunk 事件）
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
        // 暴露 flushPendingNarration 给 scene change / signal 挂起 / generate 结束，
        // 让这些"叙事边界"把正在攒的 narration 推给前端。
        // (TS: 这里用 closure，不暴露到 this —— 下面同 try 块内调用即可)
        // 把 applyScenePatch 包装一层：除了更新 this.currentScene，
        // 还要 emit scene-change 事件 + 产出一条 scene_change Sentence + Langfuse 事件
        this.scenePatchEmitter = (transition) => {
          // 先把攒着的 narration emit 掉，再插 scene-change，保证玩家看到的顺序是
          // "前一段旁白 → 场景切换 → 后一段旁白"
          flushPendingNarration();
          this.emitter.emitSceneChange(this.currentScene, transition);
          emitSentenceFrom({ kind: 'scene_change', scene: { ...this.currentScene }, transition });
          traceHandle?.event(
            'scene-change',
            { scene: this.currentScene, transition },
            { turn },
          );
        };
        // signal_input_needed 挂起前 game-session 需要把攒的 narration emit 给前端。
        // 把 flush 暴露到实例字段，让 createWaitForPlayerInput 能调用到这个 closure。
        this.pendingNarrationFlusher = flushPendingNarration;

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
          // Focus Injection D：per-step 读 state，focus 变了就重 assemble
          //
          // 注意 AI SDK 的 prepareStep 语义：返回 undefined → 用**外层初始** system；
          // 返回 string → 覆盖本 step 的 system。所以一旦 focus 变过一次，之后每个
          // step 都必须返回**当时的 cachedSystemPrompt**（而不是 undefined），否则
          // AI SDK 会回到外层初始 prompt，把之前 refresh 过的场景段又丢了。
          //
          // Provider 侧 prompt cache：每次返回相同字符串时 prefix 一致，能命中 cache。
          // 只有 focus 真的变了那一 step 会 miss 一次。
          prepareStepSystem: async ({ stepNumber }) => {
            // step 0 外层已 assemble 过了，返回 undefined 让 AI SDK 用外层 systemPrompt
            if (stepNumber === 0) return undefined;
            const curFocus = computeFocus(this.stateStore.getAll());
            const curKey = focusKey(curFocus);
            if (curKey === cachedFocusKey) {
              // focus 没变。如果从没 refresh 过（cachedSystemPrompt 就是外层那份），
              // 返回 undefined 让 AI SDK 用外层；否则返回缓存值维持现状。
              if (cachedSystemPrompt === context.systemPrompt) return undefined;
              return cachedSystemPrompt;
            }
            // focus 变了 → 重 assemble
            const prevFocus = JSON.parse(cachedFocusKey) as unknown;
            const newCtx = await runAssemble(curFocus);
            cachedFocusKey = curKey;
            cachedSystemPrompt = newCtx.systemPrompt;
            // 可观测性：给 tracing 层打一条 focus 变更事件
            traceHandle?.event(
              'focus-refresh',
              { from: prevFocus, to: curFocus },
              { stepNumber },
            );
            return newCtx.systemPrompt;
          },
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
              stepStartAt: step.stepStartAt,
              stepInputMessages: step.stepInputMessages,
              effectiveSystemPrompt: step.effectiveSystemPrompt,
            });
          },
        });

        this.abortController = null;

        // M3: parser 末尾降级（把未闭合 <d> 当 truncated 结束）
        narrativeParser.finalize();
        // finalize 会把 parser 里剩余的 narrationBuffer emit 成 onNarrationChunk，
        // 最后再 flush 一次 session 层累积器，保证整 generate 的 narration 全到前端
        flushPendingNarration();
        this.scenePatchEmitter = null;
        this.pendingNarrationFlusher = null;

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
          memorySnapshot: memSnapGen,
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
        // 同样保存 memory snapshot，断线重连时不丢失
        const memSnapWait = await this.memory.snapshot();
        await this.persistence?.onWaitingInput({
          hint: null,
          inputType: 'freetext',
          choices: null,
          memorySnapshot: memSnapWait,
          currentScene: this.currentScene,
        }).catch((e) => console.error('[Persistence] onWaitingInput failed:', e));

        const inputText = await this.waitForInput();

        if (!this.active) break; // stopped while waiting

        // Clear error banner on new input
        this.emitter.setError(null);

        if (inputText) {
          this.emitter.appendEntry({ role: 'receive', content: inputText });
          this.emitPlayerInputSentence(inputText);

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
    const parts: string[] = [];
    if (focus.scene) parts.push(focus.scene);
    // v2: if (focus.stage) parts.push(focus.stage);
    // v2: if (focus.characters?.length) parts.push(focus.characters.join(', '));
    if (this.lastPlayerInput) parts.push(this.lastPlayerInput);
    return parts.join('. ');
  }

  /** 创建 waitForPlayerInput 回调，供 signal_input_needed 的 execute 使用 */
  /**
   * 把玩家输入 emit 成一条 `player_input` Sentence，让 VN UI（对话框 / backlog）
   * 能显示"玩家的回复气泡"。
   *
   * 在 signal 挂起路径和外循环 Receive 路径下都要调，保持叙事流里玩家和 GM
   * 一问一答的顺序。restore 路径也会为 `role='receive'` entries 合成同样的 Sentence
   * （在 ws-client-emitter 的 'restored' 分支里做）。
   *
   * index 用 Date.now()：player_input 不在 generate 内部的 turnSentenceIndex
   * 序列里，只需要全局单调即可（前端按 parsedSentences 数组顺序渲染，index 字段
   * 只是 React key 和诊断标识）。
   */
  private emitPlayerInputSentence(text: string): void {
    this.emitter.appendSentence({
      kind: 'player_input',
      text,
      sceneRef: { ...this.currentScene },
      turnNumber: this.stateStore.getTurn(),
      index: Date.now(),
    });
  }

  private createWaitForPlayerInput(): (options: SignalInputOptions) => Promise<string> {
    return async (options: SignalInputOptions) => {
      // ★ signal 挂起前先把 narration 累积 buffer 推给前端：
      //   parser 层已经 flush 出 onNarrationChunk，session 层的
      //   pendingNarrationFlusher 再把攒着的段落拼成 Sentence 推出去。
      //   否则"完全不带 XML 标签的段落"在本轮会滞留到 generate 结束，
      //   玩家先看到选项再看到叙事（或根本看不到叙事）。
      this.pendingNarrationFlusher?.();

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
      // 同时保存最新的 memory snapshot → 断线重连后 memory 不空
      const memSnapSignal = await this.memory.snapshot();
      await this.persistence?.onWaitingInput({
        hint: options.hint ?? null,
        inputType: options.choices?.length ? 'choice' : 'freetext',
        choices: options.choices ?? null,
        memorySnapshot: memSnapSignal,
        currentScene: this.currentScene,
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
