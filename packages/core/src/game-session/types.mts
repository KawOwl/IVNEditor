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
  event(name: string, input?: unknown, metadata?: Record<string, unknown>): void;
  error(message: string, phase: string): void;
  end(finalOutput?: unknown): void;
}

export interface ToolCallTraceHandle {
  end(output: unknown, error?: string): void;
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
  coreEventReader?: CoreEventHistoryReader;
  protocolVersion?: ProtocolVersion;
  parserManifest?: ParserManifest;
  characters?: ReadonlyArray<CharacterAsset>;
  backgrounds?: ReadonlyArray<BackgroundAsset>;
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
  coreEventReader?: CoreEventHistoryReader;
  protocolVersion?: ProtocolVersion;
  parserManifest?: ParserManifest;
  characters?: ReadonlyArray<CharacterAsset>;
  backgrounds?: ReadonlyArray<BackgroundAsset>;
}
