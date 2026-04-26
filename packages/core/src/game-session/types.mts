import type {
  MemoryConfig,
  PromptSegment,
  ProtocolVersion,
  SceneState,
  StateSchema,
  CharacterAsset,
  BackgroundAsset,
} from '#internal/types';
import type { LLMConfig } from '#internal/llm-client';
import type { CoreEventHistoryReader } from '#internal/game-session/core-event-history';
import type { MemoryDeletionFilter } from '#internal/memory/types';
import type { RetrievalLogger } from '#internal/memory/retrieval-logger';
import type { ParserManifest } from '#internal/narrative-parser-v2';
import type { CoreEventSink } from '#internal/game-session/core-events';

/**
 * SessionPersistence — 可选的持久化回调接口
 *
 * 远程模式下由 server 注入实现（写 DB），本地模式不传。
 */
export interface SessionPersistence {
  onGenerateStart(turn: number): Promise<void>;

  onGenerateComplete(data: {
    memorySnapshot: Record<string, unknown>;
    preview?: string | null;
    currentScene?: SceneState | null;
  }): Promise<void>;

  onWaitingInput(data: {
    hint: string | null;
    inputType: string;
    choices: string[] | null;
    memorySnapshot?: Record<string, unknown>;
    currentScene?: SceneState | null;
    stateVars?: Record<string, unknown>;
  }): Promise<void>;

  onReceiveComplete(data: {
    stateVars: Record<string, unknown>;
    turn: number;
    memorySnapshot: Record<string, unknown>;
  }): Promise<void>;

  onScenarioFinished?(data: {
    reason?: string;
  }): Promise<void>;
}

export interface GenerateTraceHandle {
  setInput(input: {
    systemPrompt: string;
    messages: Array<{ role: string; content: string }>;
  }): void;

  recordStep(step: {
    stepNumber: number;
    text: string;
    reasoning?: string;
    finishReason: string;
    inputTokens?: number;
    outputTokens?: number;
    model?: string;
    partKinds: string[];
    responseTimestamp?: Date;
    stepStartAt?: Date;
    stepInputMessages?: Array<{ role: string; content: string }>;
    effectiveSystemPrompt?: string;
    isFollowup?: boolean;
  }): void;

  startToolCall(name: string, args: unknown): ToolCallTraceHandle;
  /**
   * 开一个 child generation observation，挂在主 generate trace 下。
   * 用于记录主 LLM 路径之外的辅助 LLM call（典型：narrative-rewrite）。
   * Langfuse UI 里这些 call 跟主 step 在同一 trace 时间线上可见。
   */
  startNestedGeneration(opts: {
    name: string;
    model?: string;
    input?: unknown;
    metadata?: Record<string, unknown>;
  }): NestedGenerationTraceHandle;
  event(name: string, input?: unknown, metadata?: Record<string, unknown>): void;
  error(message: string, phase: string): void;
  end(finalOutput?: unknown): void;
}

export interface ToolCallTraceHandle {
  end(output: unknown, error?: string): void;
}

export interface NestedGenerationTraceHandle {
  end(opts: {
    text?: string;
    finishReason?: string;
    inputTokens?: number;
    outputTokens?: number;
    error?: string;
    metadata?: Record<string, unknown>;
  }): void;
}

export interface SessionTracing {
  startGenerateTrace(turn: number, metadata?: Record<string, unknown>): GenerateTraceHandle;
  markSessionRestored(turn: number, metadata?: Record<string, unknown>): void;
}

export interface RestoreConfig {
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
  coreEventSink?: CoreEventSink;

  stateVars: Record<string, unknown>;
  turn: number;
  memorySnapshot: Record<string, unknown> | null;
  status: string;
  inputHint?: string | null;
  inputType?: string;
  choices?: string[] | null;
  currentScene?: SceneState | null;
  defaultScene?: SceneState;
  mem0ApiKey?: string;
  memoraxConfig?: { baseUrl: string; apiKey: string; appId?: string };
  coreEventReader?: CoreEventHistoryReader;
  protocolVersion?: ProtocolVersion;
  parserManifest?: ParserManifest;
  characters?: ReadonlyArray<CharacterAsset>;
  backgrounds?: ReadonlyArray<BackgroundAsset>;
  /** ANN.1：详见 GameSessionConfig 同名字段 */
  memoryDeletionFilter?: MemoryDeletionFilter;
  memoryRetrievalLogger?: RetrievalLogger;
}

export interface GameSessionConfig {
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
  coreEventSink?: CoreEventSink;
  defaultScene?: SceneState;
  mem0ApiKey?: string;
  memoraxConfig?: { baseUrl: string; apiKey: string; appId?: string };
  coreEventReader?: CoreEventHistoryReader;
  protocolVersion?: ProtocolVersion;
  parserManifest?: ParserManifest;
  characters?: ReadonlyArray<CharacterAsset>;
  backgrounds?: ReadonlyArray<BackgroundAsset>;
  /**
   * ANN.1：Memory adapter 的删除过滤器。adapter retrieve 时会过滤掉
   * 玩家标记"忘掉"的 entry。server 注入封装了 memory-annotation-service。
   */
  memoryDeletionFilter?: MemoryDeletionFilter;
  /**
   * ANN.1：每次 Memory.retrieve 后调用的日志 callback。server 注入实现：
   * 把 retrieval 落 turn_memory_retrievals 表 + emit core event 给客户端。
   */
  memoryRetrievalLogger?: RetrievalLogger;
}
