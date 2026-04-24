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
import { NarrativeParser, extractPlainText } from './narrative-parser';
import {
  createParser as createParserV2,
  type NarrativeParser as NarrativeParserV2,
  type ParserManifest,
  type DegradeEvent as DegradeEventV2,
} from './narrative-parser-v2';
import { serializeMessagesForDebug } from './messages-builder';
import type {
  Sentence,
  ParticipationFrame,
  SceneState,
  ScratchBlock,
  ProtocolVersion,
} from './types';

/**
 * 视觉 IR 协议版本（RFC-声明式视觉IR_2026-04-24 §6.1）。缺省（undefined）
 * 视为 'v1-tool-call'：老 NarrativeParser + change_scene / change_sprite /
 * clear_stage 工具驱动视觉；新剧本设 'v2-declarative-visual' 用 parser-v2
 * 自己从嵌套 XML 子标签里推导视觉状态，视觉 tools 不启用。
 *
 * V.3（2026-04-24）：类型定义挪到 `./types.ts`（engine-rules / schemas 等
 * 纯类型层需要引用）；此处 re-export 保持向后兼容。
 */
export type { ProtocolVersion } from './types';

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
 * 根据玩家输入 + 当前挂起的 choices 算 player_input entry 的结构化 payload。
 * （migration 0010 / Step 3，见 .claude/plans/conversation-persistence.md）
 *
 *   choices 空 / null   → 纯自由输入，inputType='freetext'
 *   text 精确命中某项  → inputType='choice' + selectedIndex=命中下标
 *   text 不匹配        → 玩家选了自由输入绕开 choices，仍然 'freetext'
 *
 * 导出以便测试；submitInput 和 restore 路径都用这个函数统一逻辑。
 */
export function computeReceivePayload(
  text: string,
  choices: string[] | null,
): { inputType: 'choice' | 'freetext'; selectedIndex?: number } {
  if (!choices || choices.length === 0) {
    return { inputType: 'freetext' };
  }
  const idx = choices.indexOf(text);
  if (idx >= 0) {
    return { inputType: 'choice', selectedIndex: idx };
  }
  return { inputType: 'freetext' };
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
    /** migration 0011：同 LLM step 产出的 entries 共享的 batchId，null 表示未知 */
    batchId?: string | null;
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
    /**
     * 2026-04-24：state 变量快照。LLM 在本轮 generate() 里通过 update_state
     * 改动过的 state（比如章节切换 chapter=2）必须在这里持久化，否则断线重连
     * 时 DB 的 state_vars 滞后一个回合（chapter 还是 1 但 history 已在 ch2），
     * restore 后 LLM 看到的 state 和历史不一致。
     *
     * 这个字段和 currentScene 的持久化时机对称：generate 返回后、等玩家输入前。
     */
    stateVars?: Record<string, unknown>;
  }): Promise<void>;

  /**
   * `signal_input_needed` 工具被 LLM 调用时写一条结构化事件
   * （migration 0010，见 .claude/plans/conversation-persistence.md）。
   *
   * 语义上等价于"GM 在这一步提了问，给出了这些选项"。持久化后：
   *   - backlog 能回看历史问答
   *   - 未来 fork 能用它定位分支点
   *
   * 和 `onWaitingInput` 的区别：
   *   - onWaitingInput 更新 `playthroughs` 的"当前状态"快照（input_hint/choices）
   *   - onSignalInputRecorded 在 `narrative_entries` 追加一条不可变事件
   *
   * 外循环无 tool 的 Receive phase 不调本方法（没有 hint/choices，也不是
   * 结构化事件）。
   */
  onSignalInputRecorded?(data: {
    hint: string;
    choices: string[];
    /** migration 0011：同 LLM step 产出的 entries 共享的 batchId，null 表示未知 */
    batchId?: string | null;
  }): Promise<void>;

  /**
   * 非 signal_input / end_scenario 的"普通"工具（update_state / change_scene /
   * pin_memory / query_memory 等）调用完成时触发（migration 0011 / PR-M1）。
   * 持久化层按 kind='tool_call' 写一条 narrative_entry。
   *
   * 触发点：llm-client 的 experimental_onToolCallFinish 钩子（经由
   * GenerateOptions.onToolObserved 透传给 game-session，再转发到这里）。
   */
  onToolCallRecorded?(data: {
    toolName: string;
    input: unknown;
    output: unknown;
    batchId: string;
  }): Promise<void>;

  /** 玩家输入完成 */
  onReceiveComplete(data: {
    entry: { role: string; content: string };
    stateVars: Record<string, unknown>;
    turn: number;
    memorySnapshot: Record<string, unknown>;
    /**
     * migration 0010 / Step 3：player_input entry 的结构化载荷。
     *   inputType='choice'   玩家从 signal_input_needed 的 choices 里选了一个
     *     + selectedIndex    选的是 choices[selectedIndex]
     *   inputType='freetext' 玩家自由输入（可能没 signal，也可能有 signal 但没选 choice）
     *     + selectedIndex    undefined
     * 让未来 backlog / fork 能准确还原"是选的第几个还是自己敲的"。
     */
    payload?: {
      inputType: 'choice' | 'freetext';
      selectedIndex?: number;
    };
    /**
     * migration 0011：玩家一次提交的 batchId。
     * 每次 submit 独立 UUID；未来多模态一次提交多 entry 共享同一 UUID。
     */
    batchId?: string | null;
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
    /**
     * 该 step 是否是 llm-client 的 post-step 补刀（2026-04-24）。
     * tracing 层据此在 generation name / metadata 上标记，方便事后筛选。
     */
    isFollowup?: boolean;
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
  /**
   * Memory Refactor v2：从 narrative_entries 读历史的接口。
   * server 侧传入 createNarrativeHistoryReader(playthroughId)。本地模式不传。
   */
  narrativeReader?: import('./memory/narrative-reader').NarrativeHistoryReader;
  /** 视觉 IR 协议版本（RFC §6.1，同 GameSessionConfig）。 */
  protocolVersion?: ProtocolVersion;
  /** v2 parser 白名单。仅 protocolVersion='v2-declarative-visual' 时必填。 */
  parserManifest?: ParserManifest;
  /**
   * V.3：system prompt 里 `[白名单]` 段需要原始 id 列表（CharacterAsset[]）
   * 供 `buildEngineRules()` 插入；等价于 ScriptManifest.characters。
   */
  characters?: ReadonlyArray<import('./types').CharacterAsset>;
  /** V.3：同上，等价于 ScriptManifest.backgrounds。 */
  backgrounds?: ReadonlyArray<import('./types').BackgroundAsset>;
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
  /**
   * Memory Refactor v2：从 narrative_entries 读历史的接口。
   * server 侧传入 createNarrativeHistoryReader(playthroughId)。本地模式不传。
   */
  narrativeReader?: import('./memory/narrative-reader').NarrativeHistoryReader;
  /**
   * 声明式视觉 IR（RFC 2026-04-24 §6.1）。
   *   - 缺省 / 'v1-tool-call'：走老 NarrativeParser + change_scene 系列工具
   *   - 'v2-declarative-visual'：走 parser-v2 + 子标签推导视觉；要求同时
   *     提供 parserManifest（白名单来源于剧本的 characters / backgrounds）
   */
  protocolVersion?: ProtocolVersion;
  /** v2 parser 的白名单表。仅在 protocolVersion='v2-declarative-visual' 时必填。 */
  parserManifest?: ParserManifest;
  /**
   * V.3：system prompt 的 `[白名单]` 段展开用 —— 剧本角色 + 立绘（情绪）列表。
   * 等同于 `ScriptManifest.characters`；v2 下建议提供（空数组仍渲染 emptyHint），
   * v1 下不读。parserManifest 是相同数据的 Set/Map 形态，prompt 侧要保序所以
   * 沿用原数组。
   */
  characters?: ReadonlyArray<import('./types').CharacterAsset>;
  /** V.3：`ScriptManifest.backgrounds`，同 `characters`。 */
  backgrounds?: ReadonlyArray<import('./types').BackgroundAsset>;
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
  // （老 currentTraceHandle 字段已删除 —— 方案 B 下 traceHandle 局部变量即可覆盖
  //  generate trace 的生命周期；之前是为给 signal 挂起路径的 player_input 事件
  //  记录用，turn-bounded 后没有这个路径）

  /**
   * 当前 streaming entry 的叙事文本累积区。
   * 用途：signal_input_needed 挂起时先把这段文本持久化到 DB，
   * 避免 generate() 一直挂起导致的叙事丢失。
   * 每次 beginStreamingEntry 前重置，每次 finalize 前 flush 到 DB。
   */
  private currentNarrativeBuffer = '';

  /**
   * 本轮 LLM 产生的 reasoning (thinking) 累积缓冲 —— reasoner 类模型
   * （DeepSeek V4 Flash thinking、deepseek-reasoner 等）会产出，写进
   * narrative_entries.reasoning。
   *
   * 为什么要存：DeepSeek thinking 模式要求回放 assistant message 时把
   * reasoning_content 也带上，否则 API 报 "The reasoning_content in the
   * thinking mode must be passed back to the API"（方案 A 结构化 messages
   * 开始带 ToolCallPart 之后暴露；之前都是纯 string content 所以 DeepSeek
   * 没抱怨）。
   *
   * messages-builder 会把 entry.reasoning 投影成 AI SDK 的 ReasoningPart，
   * openai-compatible provider 序列化为 reasoning_content 字段。
   */
  private currentReasoningBuffer = '';

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
   * v2 路径（RFC 2026-04-24）：由 parser-v2 每条 Sentence 的 sceneRef 更新。
   * start() 时从 manifest.defaultScene 或 {background:null, sprites:[]} 初始化，
   * restore() 时从 DB 恢复。每次变化在 generate 结束后持久化。
   */
  private currentScene: import('./types').SceneState = {
    background: null,
    sprites: [],
  };

  /**
   * 视觉 IR 协议版本（RFC §6.1）。start()/restore() 时注入；缺省 v1-tool-call。
   * generate() 据此选 parser 路径。
   */
  private protocolVersion: ProtocolVersion = 'v1-tool-call';

  /**
   * v2 parser 白名单。只在 protocolVersion='v2-declarative-visual' 时使用。
   */
  private parserManifest?: ParserManifest;

  /**
   * V.3：system prompt 里 `[白名单]` 段展开用。
   *   - v2 path：`buildEngineRules({ characters, backgrounds })` 插入 id + 情绪列表
   *   - v1 path：不读；保留为空数组即可
   * 保留原数组而非 parserManifest（Set/Map）的理由：prompt 输出顺序稳定需要
   * 原序数组，Set 迭代顺序虽然在实现上也稳定，但语义更弱。
   */
  private characters: ReadonlyArray<import('./types').CharacterAsset> = [];
  private backgrounds: ReadonlyArray<import('./types').BackgroundAsset> = [];

  /**
   * M3: applyScenePatch 完成后额外触发——发出 WS 事件 + 产出 scene_change Sentence。
   * 只在 generate() 执行期间非 null。由 generate() 内部初始化。
   */
  private scenePatchEmitter:
    | ((transition?: 'fade' | 'cut' | 'dissolve') => void)
    | null = null;

  /**
   * 把 generate() 内部 narration 累积 buffer 刷出去。
   * signal_input_needed 的 record-only execute 调这个，确保玩家在看到选项之前
   * 先看到最新的旁白 Sentence。generate() 执行期间非 null。
   */
  private pendingNarrationFlusher: (() => void) | null = null;

  // 外循环 Receive 阶段的挂起 Promise（等玩家输入，signal / natural stop / maxSteps 共用）
  private inputResolve: ((text: string) => void) | null = null;

  /**
   * 当前等玩家输入的 signal（方案 B / 2026-04-23 turn-bounded）。
   *
   * 生命周期：
   *   - signal_input_needed.execute 调 recordPendingSignal 回调时设置
   *   - generate() 因 stopWhen hit 而返回后，coreLoop 的 Receive 阶段读它决定 UI 模式
   *   - 玩家输入提交、写完 player_input entry 后清回 null
   *
   * null 表示"当前回合没有 signal（LLM 自然停止 / maxSteps / restore 后新一轮）"，
   * 此时 Receive 阶段走 freetext 路径。
   */
  private pendingSignal: {
    hint: string;
    choices: string[];
    /** 发起 signal 的 LLM step 的 batchId，用于 signal_input / narrative / player_input 分组 */
    batchId: string | null;
  } | null = null;

  /**
   * 当前 LLM step 的 batchId（migration 0011）。onStep 回调里从 StepInfo.batchId
   * 取到并缓存；onSignalInputRecorded / onNarrativeSegmentFinalized 挂起时把它
   * 一并透传给 persistence，让 narrative_entries.batch_id 统一标记"同一次 LLM
   * 响应产出的 entries"。
   *
   * 生命周期：onStepStart 触发时更新（Bug B 修复 2026-04-24：原先是 onStep
   * 即 stepFinish 才更新，导致同 step 内 tool.execute 时读到**上一 step** 的
   * batchId，signal_input / narrative 挂错批次）；onStep 仍然兜底重复写一遍
   * 以防 onStepStart 回调某种异常未触发；generate() 结束时（finally 块）清空。
   */
  private currentStepBatchId: string | null = null;

  /**
   * 当前 generate 回合的 turn number（Bug A 修复 2026-04-24）。
   *
   * 用途：recordPendingSignal 里在 signal_input 写入**之前**，要把 currentNarrativeBuffer
   * pre-flush 到 memory + DB，保证 narrative_entries 的 orderIdx 顺序和玩家看到的
   * 顺序一致（narrative → signal_input）。memory.appendTurn 需要 turn 参数，而 turn
   * 是 coreLoop 内 `const turn` 局部变量，recordPendingSignal 在另一个栈里看不到，
   * 所以存一份到 this。
   *
   * 生命周期：coreLoop 每次 generate 开始时赋值；不在 finally 里清零（没必要，
   * 下一次 generate 会覆写）。
   */
  private currentTurn: number = 0;

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
        throw new Error(
          '[GameSession] protocolVersion="v2-declarative-visual" 要求同时提供 parserManifest',
        );
      }

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
        throw new Error(
          '[GameSession] restore: protocolVersion="v2-declarative-visual" 要求同时提供 parserManifest',
        );
      }

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
    this.abortController?.abort();
    this.abortController = null;

    // resolve 外循环的 waitForInput（防挂死）；方案 B 下没有 signalInputResolve 了
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
      // Bug A 修复：把 turn 挂到实例，recordPendingSignal 里 memory.appendTurn 要用
      this.currentTurn = turn;

      // ① 持久化：generate 开始
      await this.persistence?.onGenerateStart(turn).catch((e) =>
        console.error('[Persistence] onGenerateStart failed:', e));

      // migration 0011：新 generate 开始，清空 batchId 防上一轮残留串台
      this.currentStepBatchId = null;

      // 🔭 可观测性：为这一轮 generate 开启 trace（在 try 外层定义，catch 也能访问）
      const traceHandle: GenerateTraceHandle | undefined = this.tracing?.startGenerateTrace(turn);
      const toolCallStack = new Map<string, ToolCallTraceHandle[]>();

      try {
        // Create tools with turn-bounded recordPendingSignal handler
        const allTools = createTools({
          stateStore: this.stateStore,
          memory: this.memory,
          segments: this.segments,
          recordPendingSignal: async (options) => {
            await this.recordPendingSignal(options);
          },
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
            protocolVersion: this.protocolVersion,
            characters: this.characters,
            backgrounds: this.backgrounds,
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

        // context.messages 是 ModelMessage[]（可能含 tool-call / tool-result parts）。
        // emitter / tracing 的消费者期望 {role, content: string} 扁平结构 —— 用
        // serializeMessagesForDebug 把 parts 序列化为可读的 "[tool-call] {...json...}"
        // 行。EditorDebugPanel 和 Langfuse trace.input 直接展示就行。
        const debugMessages = serializeMessagesForDebug(context.messages);

        // Update global debug state
        this.emitter.updateDebug({
          tokenBreakdown: context.tokenBreakdown,
          assembledSystemPrompt: context.systemPrompt,
          assembledMessages: debugMessages,
          activeSegmentIds,
        });

        // Stage prompt snapshot for this generation entry
        this.emitter.stagePendingDebug({
          promptSnapshot: {
            systemPrompt: context.systemPrompt,
            messages: debugMessages,
            tokenBreakdown: context.tokenBreakdown,
            activeSegmentIds,
          },
        });

        // Create abort controller for this generate() call
        this.abortController = new AbortController();

        // 创建 streaming entry（文本将直接追加到这条 entry）
        this.currentNarrativeBuffer = '';
        this.currentReasoningBuffer = '';
        this.emitter.beginStreamingEntry();

        // 🔭 可观测性：设置 trace 初始上下文（展示 LLM 看到的 prompt）
        traceHandle?.setInput({
          systemPrompt: context.systemPrompt,
          messages: debugMessages,
        });

        // Parser 分叉（RFC 2026-04-24 §6.1）：按 protocolVersion 选 v1 / v2。
        //
        // 两条路径都暴露同一组局部 API 给下面的 generate() 循环使用：
        //   - feedTextChunk(chunk)     : text-delta 喂给对应 parser
        //   - finalizeParser()         : LLM 结束后 flush 剩余 open 容器
        //   - flushPendingNarration()  : 在 scene-change / signal-suspend 边界
        //                                 把 v1 累积器里未 emit 的 narration 推出；
        //                                 v2 路径下无状态，noop
        //
        // 同时共享 turnSentenceIndex（Sentence.index 按每轮从 0 起）。
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

        // ────────────────────────────────────────────────────────────────
        // Parser 分叉点
        // ────────────────────────────────────────────────────────────────
        let feedTextChunk: (chunk: string) => void;
        let finalizeParser: () => void;
        let flushPendingNarration: () => void;

        if (this.protocolVersion === 'v2-declarative-visual') {
          // ── v2: 声明式嵌套 XML（parser-v2）────────────────────────────
          // parser-v2 在内部做视觉状态继承：每条 Sentence 自带 sceneRef。
          // 我们把 parser 返回的 sentence 透传给 emitter（不再经 emitSentenceFrom
          // 读 this.currentScene，因为 sceneRef 已经是 resolved 后的），
          // 并用最后一条 sentence 的 sceneRef 刷新 this.currentScene 用于持久化。
          const parserV2: NarrativeParserV2 = createParserV2({
            manifest: this.parserManifest!,
            turnNumber: turn,
            startIndex: 0,
            initialScene: { ...this.currentScene },
          });

          const drainBatch = (batch: {
            readonly sentences: ReadonlyArray<Sentence>;
            readonly scratches: ReadonlyArray<ScratchBlock>;
            readonly degrades: ReadonlyArray<DegradeEventV2>;
          }) => {
            for (const s of batch.sentences) {
              // parser-v2 只 emit narration / dialogue（不 emit scene_change —— 视觉
              // 状态转移由 sceneRef 本身编码，不再走离散的 scene_change Sentence）。
              // 这里判掉 scene_change 分支仅作 TS 收窄用；运行时一定走 else。
              if (s.kind === 'scene_change') {
                this.emitter.appendSentence(s);
                turnSentenceIndex = Math.max(turnSentenceIndex, s.index + 1);
                continue;
              }
              // sceneRef 已经正确 resolve；作用于 this.currentScene
              // 以便 onGenerateComplete / onWaitingInput 持久化到 DB。
              this.currentScene = { ...s.sceneRef };
              this.emitter.appendSentence(s);
              // 继续推进 turn-local 索引（parser 内部也维护一个等价 counter）
              turnSentenceIndex = Math.max(turnSentenceIndex, s.index + 1);
              if (s.kind === 'dialogue' && s.truncated) {
                traceHandle?.event(
                  'narrative-truncation',
                  { speaker: s.pf.speaker, partialLength: s.text.length },
                  { turn, kind: 'dialogue' },
                );
              }
              if (s.kind === 'narration' && s.truncated) {
                traceHandle?.event(
                  'narrative-truncation',
                  { partialLength: s.text.length },
                  { turn, kind: 'narration' },
                );
              }
            }
            if (batch.scratches.length > 0) {
              // RFC §10.1：ir-scratch 为正常事件（非 degrade），count + totalChars
              // 可用于观察 LLM 转移元叙述的频率。不渲染、不产 Sentence；
              // 但 <scratch> 原文已在 currentNarrativeBuffer 里，messages-builder
              // 下一轮自然 replay 到 assistant 历史，实现 in-context 强化。
              traceHandle?.event(
                'ir-scratch',
                {
                  count: batch.scratches.length,
                  totalChars: batch.scratches.reduce((n, s) => n + s.text.length, 0),
                },
                { turn },
              );
            }
            for (const d of batch.degrades) {
              // 每条 degrade 打一条独立 event，detail 作为 payload 保留
              traceHandle?.event(
                `ir-degrade:${d.code}`,
                d.detail ? { detail: d.detail } : {},
                { turn },
              );
            }
          };

          feedTextChunk = (chunk) => drainBatch(parserV2.feed(chunk));
          finalizeParser = () => drainBatch(parserV2.finalize());
          flushPendingNarration = () => {
            // v2 parser 每个闭合 tag 即时 emit，没有 session 层累积器。noop。
          };
        } else {
          // ── v1: 老 XML-lite + tool-driven scene ───────────────────────
          // Narration 跨 chunk 累积器：parser 的 onNarrationChunk 按 chunk 粒度
          // 来；游戏 UI 需要段落粒度。createNarrationAccumulator 把 chunk 攒起来，
          // 遇到段落边界 / 字数阈值时 emit 成一条 narration Sentence。在 dialogue
          // 开始 / 场景切换 / signal 挂起 / generate 结束这些"叙事切换点"调 flush
          // 把残余吐出。
          const narrationAcc = createNarrationAccumulator((para) =>
            emitSentenceFrom({ kind: 'narration', text: para }),
          );
          flushPendingNarration = () => narrationAcc.flush();

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

          feedTextChunk = (chunk) => narrativeParser.push(chunk);
          finalizeParser = () => narrativeParser.finalize();
        }
        // 暴露 flushPendingNarration 给 scene change / signal 挂起 / generate 结束，
        // 让这些"叙事边界"把正在攒的 narration 推给前端。
        // (TS: 这里用 closure，不暴露到 this —— 下面同 try 块内调用即可)
        //
        // V.2：scenePatchEmitter 仅在 v1 path 启用。
        //   - v1：change_scene/change_sprite/clear_stage 工具调 applyScenePatch，
        //     会通过 scenePatchEmitter emit 一条 scene-change WS event + scene_change Sentence。
        //   - v2：声明式 IR 里视觉状态随 Sentence.sceneRef 走，不再 emit scene-change
        //     WS event（RFC §6）。v2 也不注册那三个工具，applyScenePatch 根本不会被调。
        //     留 null 即可。
        if (this.protocolVersion === 'v2-declarative-visual') {
          this.scenePatchEmitter = null;
        } else {
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
        }
        // signal_input_needed record-only 前 game-session 需要把攒的 narration emit 给前端。
        // 把 flush 暴露到实例字段，让 recordPendingSignal 能调用到这个 closure。
        // v2 path flushPendingNarration 是 noop（parser-v2 即时 emit），这里也安全。
        this.pendingNarrationFlusher = flushPendingNarration;

        // Call LLM (agentic tool loop — stopWhen 在 signal_input_needed / end_scenario 触发时拦截)
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
            // V.2：v1 走老 parser（narrativeParser.push），v2 走 parser-v2；
            // feedTextChunk 是上面 if/else 里定义的分叉点。
            feedTextChunk(chunk);
          },
          onReasoningChunk: (chunk) => {
            this.currentReasoningBuffer += chunk;
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
          onStepStart: (info) => {
            // Bug B 修复（2026-04-24）：在 step **开始时**就把当前 step 的 batchId
            // 挂到 this.currentStepBatchId，这样本 step 内 tool.execute 调用的
            // recordPendingSignal / onToolObserved 读到的永远是当前 step 的 batchId，
            // 而不是上一 step 的或 null。isFollowup 的 step 跳过（见下方 onStep 的
            // isFollowup 注释），保持在主 generate 最后一个 step 的 batchId。
            if (!info.isFollowup) {
              this.currentStepBatchId = info.batchId;
            }
          },
          onStep: (step) => {
            // migration 0011：缓存当前 step 的 batchId 供挂起期 / finalize 期挂载
            //
            // Bug B 修复后（2026-04-24）：主路径已经由 onStepStart 接管，这里保留
            // 是作为兜底（万一 onStepStart 某种异常没跑）；值和 onStepStart 一致，
            // 重复写不会错。
            //
            // isFollowup 门控（方案 A post-step 补刀，2026-04-24）：
            //   follow-up step 是 llm-client 在主 generate 空停时自动追发的
            //   补刀请求（详见 llm-client.ts GenerateOptions.onStep 中
            //   isFollowup 注释）。补刀里 signal_input_needed 的
            //   recordPendingSignal 已经用**主最后一个 step** 的 batchId 挂
            //   载了 signal_input entry；这里如果让 follow-up 覆盖
            //   currentStepBatchId，下一步 flushNarrativeBuffer 会把 narrative
            //   entry 挂到 follow-up 的新 batchId，导致 narrative 和
            //   signal_input 跨 batch，messages-builder 会投成两个 assistant
            //   message（一个只有 narrative，一个只有 signal）。不希望这样。
            //   所以补刀的 step 只走 tracing（下方 recordStep），**不**更新
            //   currentStepBatchId。
            if (!step.isFollowup) {
              this.currentStepBatchId = step.batchId ?? null;
            }
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
              isFollowup: step.isFollowup,
            });
          },
          // migration 0011 / PR-M1：非 signal/end 类工具调用写 kind='tool_call' entry
          onToolObserved: async (evt) => {
            await this.persistence?.onToolCallRecorded?.({
              toolName: evt.toolName,
              input: evt.input,
              output: evt.output,
              batchId: evt.batchId,
            }).catch((e) =>
              console.error('[Persistence] onToolCallRecorded failed:', e),
            );
          },
        });

        this.abortController = null;

        // M3: parser 末尾降级（把未闭合 <d> 当 truncated 结束）
        // V.2：v1 走老 parser.finalize()，v2 走 parser-v2.finalize() 并 drainBatch
        finalizeParser();
        // finalize 会把 parser 里剩余的 narrationBuffer emit 成 onNarrationChunk，
        // 最后再 flush 一次 session 层累积器，保证整 generate 的 narration 全到前端
        flushPendingNarration();
        this.scenePatchEmitter = null;
        this.pendingNarrationFlusher = null;

        // Stage finish reason
        this.emitter.stagePendingDebug({ finishReason: result.finishReason });

        // Finalize streaming → append to narrative entries (with attached debug info)
        this.emitter.finalizeStreamingEntry();

        // Store LLM response in memory + 持久化 narrative entry。
        //
        // 方案 B（turn-bounded）下一次 generate 对应一个玩家回合。
        // currentNarrativeBuffer 包含本轮 LLM 产出的全部 narrative text
        // （signal_input 路径也不再提前 flush，见 recordPendingSignal 注释）。
        //
        // 这里一次性写 memory + narrative_entries。narrative 的 batchId 挂当前
        // step 的 id，和同 step 的 tool_call / signal_input entry 共享 batch
        // → messages-builder 按 batchId 分组合并为一个 assistant message。
        if (this.currentNarrativeBuffer) {
          await this.memory.appendTurn({
            turn,
            role: 'generate',
            content: this.currentNarrativeBuffer,
            tokenCount: estimateTokens(this.currentNarrativeBuffer),
          });
        }

        // ② 持久化：本轮 narrative 段入 narrative_entries
        if (this.currentNarrativeBuffer) {
          await this.persistence?.onNarrativeSegmentFinalized({
            entry: {
              role: 'generate',
              content: this.currentNarrativeBuffer,
              // reasoner 类模型的 thinking 内容。DeepSeek v4 Flash thinking 模式
              // 要求重放时带回 reasoning_content，messages-builder 会投影成
              // ReasoningPart。空字符串 → null 统一走 DB NULL 约束，avoid 浪费
              // 列空间存 ''。
              reasoning: this.currentReasoningBuffer || undefined,
              finishReason: result.finishReason,
            },
            // migration 0011：最后一 step 的 batchId（onStep 里缓存的最后一帧）
            batchId: this.currentStepBatchId,
          }).catch((e) => console.error('[Persistence] onNarrativeSegmentFinalized (final) failed:', e));
          this.currentNarrativeBuffer = '';
          this.currentReasoningBuffer = '';
        }

        // 同步 memory 快照和 preview
        const memSnapGen = await this.memory.snapshot();
        await this.persistence?.onGenerateComplete({
          memorySnapshot: memSnapGen,
          // preview 用 parser 抽纯文本，避免列表里裸露 `<d s="...">` —— 见 D4
          preview: result.text
            ? extractPlainText(result.text).slice(0, 80).replace(/\n/g, ' ').trim()
            : null,
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
        // migration 0011：本轮 generate 彻底结束，清 batchId 防下一轮串台
        this.currentStepBatchId = null;
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

      // --- Receive Phase ---
      // 方案 B（turn-bounded）下所有 generate() 返回后都走这里等输入：
      //   - pendingSignal 非空：LLM 调 signal_input_needed → stopWhen 拦截 → 用 signal
      //     的 hint/choices 做 UI（choice 或 freetext，看 choices 长度）
      //   - pendingSignal 空：LLM 自然停止 / maxSteps 触发 → 用 freetext UI 兜底
      // 玩家输入后 clear pendingSignal，next iteration 开新 generate()。
      if (this.active) {
        // Snapshot pendingSignal 副本：recordPendingSignal 已经完事，
        // 我们在 coreLoop 内消费。下一轮 generate 开始前清零。
        const signal = this.pendingSignal;
        const waitingHint = signal?.hint ?? null;
        const waitingChoices = signal?.choices && signal.choices.length > 0 ? signal.choices : null;
        const waitingInputType = waitingChoices ? 'choice' : 'freetext';

        // UI 状态：hint + input-type（以及可选 choices）
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

        if (!this.active) break; // stopped while waiting

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

  /**
   * 把 signal_input_needed 事件 emit 成一条 `signal_input` Sentence（migration
   * 0010 / Step 4），让 backlog 回看时能看到"GM 问了什么、给了哪些选项"。
   *
   * 对话框里不占 click（game-store 的 advanceSentence 自动跳过）；live 交互
   * 由 game-store.choices 面板承担。
   *
   * 和 `onSignalInputRecorded` DB 写入配对，两者同时调用：
   *   - appendSentence → WS 'sentence' 事件 → game-store.parsedSentences
   *   - onSignalInputRecorded → narrative_entries 表（供下次 restore 重放）
   */
  private emitSignalInputSentence(hint: string, choices: string[]): void {
    this.emitter.appendSentence({
      kind: 'signal_input',
      hint,
      choices,
      sceneRef: { ...this.currentScene },
      turnNumber: this.stateStore.getTurn(),
      index: Date.now(),
    });
  }

  /**
   * 方案 B（turn-bounded）：signal_input_needed 的 record-only handler。
   *
   * 触发路径：LLM 调 signal_input_needed → tool.execute 调 ctx.recordPendingSignal →
   * 此方法。**不挂起 Promise**，做完就 return；后续流程：
   *   1. AI SDK 把 tool_result `{success:true}` 回给 LLM
   *   2. 本 step 结束时 stopWhen 检测到 hasToolCall('signal_input_needed') → generate() 返回
   *   3. 外层 coreLoop 看到 this.pendingSignal 非空，进入 Receive 阶段等玩家输入
   *
   * 本方法内部做的事：
   *   - flush pendingNarrationFlusher → VN UI 先看到叙事 Sentence 再看到选项
   *   - emit signal_input Sentence 到 VN UI
   *   - 写 signal_input entry 进 narrative_entries（供 restore / backlog）
   *   - 设 this.pendingSignal 供 coreLoop 读
   *
   * 不做的事：
   *   - **不** flush currentNarrativeBuffer 到 DB。挂起模式 v1 时代会做，
   *     方案 B 下冗余（见下方 ★ 2 注释 + messages-builder.test.ts A1-A3
   *     canonical tests 证明 batchId 分组机制足够）
   *   - 不设 UI 状态为 waiting-input（generate 还在 generating，stopWhen 拦截后 coreLoop 切 UI）
   *   - 不调 onWaitingInput（由 coreLoop 在 generate 返回后统一调）
   *   - 不 return Promise（execute 的 async 立即 resolve → tool_result success:true 可用）
   */
  private async recordPendingSignal(options: SignalInputOptions): Promise<void> {
    const hint = options.hint ?? '';
    const choices = options.choices ?? [];

    // ★ 1. flush 累积的 narration 段落 Sentence 到 VN UI（WS 'sentence' 事件），
    //    让玩家先看到叙事再看到选项。
    this.pendingNarrationFlusher?.();

    // ★ 2. Bug A 修复（2026-04-24）：把 currentNarrativeBuffer pre-flush 到
    //    memory + DB，**之后**再写 signal_input entry。
    //
    //    为什么必须现在刷：narrative_entries 的 orderIdx 是 DB INSERT 时分配
    //    的自增序号，restore 时前端按 orderIdx ASC 回放。如果 signal_input
    //    先 insert（orderIdx=N），narrative 留到 generate 结束才 insert
    //    （orderIdx=N+1），restore 回放顺序就变成"选项 → 旁白"，和直播顺序
    //    （旁白 → 选项）完全颠倒，玩家读档后看到的历史一塌糊涂（Bug A 现象）。
    //
    //    之前的注释说"messages-builder 按 batchId 分组 orderIdx 颠倒不影响" ——
    //    那是对 LLM 看到的 assistant message 上下文的修复，messages-builder
    //    确实能按 batchId 合并。但 **history restore 给前端** 走的是
    //    loadEntries → Sentence 序列（ws-client-emitter case 'restored'），
    //    这条路径没有 messages-builder，它按 orderIdx 逐条 replay，所以这里
    //    的顺序颠倒就是玩家可见的问题。
    //
    //    流程：
    //      a. 把 buffer 快照出来 + 清空 this 字段，防止后面被重复 flush
    //      b. memory.appendTurn（memory 里也要按发生顺序追加）
    //      c. persistence.onNarrativeSegmentFinalized（DB insert，orderIdx=N）
    //      d. 紧接着 ★ 4 走 signal_input（DB insert，orderIdx=N+1）
    //      e. 后续 coreLoop 尾部通用路径会看到 currentNarrativeBuffer='' →
    //         跳过（避免重复写）
    if (this.currentNarrativeBuffer) {
      const buffered = this.currentNarrativeBuffer;
      const bufferedReasoning = this.currentReasoningBuffer;
      this.currentNarrativeBuffer = '';
      this.currentReasoningBuffer = '';

      try {
        await this.memory.appendTurn({
          turn: this.currentTurn,
          role: 'generate',
          content: buffered,
          tokenCount: estimateTokens(buffered),
        });
      } catch (e) {
        console.error('[recordPendingSignal] memory.appendTurn failed:', e);
      }

      try {
        await this.persistence?.onNarrativeSegmentFinalized({
          entry: {
            role: 'generate',
            content: buffered,
            reasoning: bufferedReasoning || undefined,
            // 标记"signal_input 前预 flush"——tracing / debug 能区分这条 entry
            // 是中途 flush 还是 generate 结束时 flush 的。
            finishReason: 'signal-input-preflush',
          },
          batchId: this.currentStepBatchId,
        });
      } catch (e) {
        console.error('[recordPendingSignal] onNarrativeSegmentFinalized failed:', e);
      }
    }

    // ★ 3. 缓存 pendingSignal 供 coreLoop Receive 阶段读（hint + choices + batchId）
    this.pendingSignal = {
      hint,
      choices,
      batchId: this.currentStepBatchId,
    };

    // ★ 4. VN Sentence + DB signal_input entry（供 backlog / restore）
    //    narrative_entries.content NOT NULL —— 只有 hint 非空才写 entry。
    //    choices 允许为空（freetext 模式 signal 也是合法事件）。
    if (hint) {
      this.emitSignalInputSentence(hint, choices);
      await this.persistence?.onSignalInputRecorded?.({
        hint,
        choices,
        batchId: this.currentStepBatchId,
      }).catch((e) => console.error('[Persistence] onSignalInputRecorded failed:', e));
    }

    // 方法到此结束 —— execute 立即 resolve tool_result success:true，stopWhen 在下一 step 前拦截
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
