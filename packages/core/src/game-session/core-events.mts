import type { DebugSnapshot } from '#internal/legacy-session-emitter';
import type {
  PromptSnapshot,
  SceneState,
  Sentence,
  ScratchBlock,
} from '#internal/types';
import type { DegradeEvent } from '#internal/narrative-parser-v2';

export type TurnId = string & { readonly __brand: 'TurnId' };
export type StepId = string & { readonly __brand: 'StepId' };
export type BatchId = string & { readonly __brand: 'BatchId' };
export type InputRequestId = string & { readonly __brand: 'InputRequestId' };

export type RuntimeSentence = Exclude<Sentence, { kind: 'scene_change' }>;

export type InputRequest =
  | {
      readonly inputType: 'freetext';
      readonly hint: string | null;
      readonly choices: null;
    }
  | {
      readonly inputType: 'choice';
      readonly hint: string | null;
      readonly choices: readonly string[];
    };

export interface SessionSnapshot {
  readonly turn: number;
  readonly stateVars: Record<string, unknown>;
  readonly memorySnapshot?: Record<string, unknown>;
  readonly currentScene: SceneState;
}

export type SessionCoreEvent =
  | {
      readonly type: 'session-started';
      readonly snapshot: SessionSnapshot;
    }
  | {
      readonly type: 'session-restored';
      readonly restoredFrom: 'idle' | 'generating' | 'waiting-input' | 'finished';
      readonly snapshot: SessionSnapshot;
    }
  | {
      readonly type: 'session-stopped';
      readonly reason: 'user' | 'abort' | 'error';
    }
  | {
      readonly type: 'session-finished';
      readonly reason?: string;
      readonly snapshot: SessionSnapshot;
    }
  | {
      readonly type: 'session-error';
      readonly phase: 'start' | 'generate' | 'receive' | 'restore';
      readonly message: string;
      readonly snapshot?: SessionSnapshot;
    };

export type GenerateCoreEvent =
  | {
      readonly type: 'generate-turn-started';
      readonly turn: number;
      readonly turnId: TurnId;
    }
  | {
      readonly type: 'context-assembled';
      readonly turnId: TurnId;
      readonly promptSnapshot: PromptSnapshot;
    }
  | {
      readonly type: 'assistant-message-started';
      readonly turnId: TurnId;
    }
  | {
      readonly type: 'llm-step-started';
      readonly turnId: TurnId;
      readonly stepId: StepId;
      readonly batchId: BatchId;
      readonly isFollowup: boolean;
    }
  | {
      readonly type: 'assistant-text-delta';
      readonly turnId: TurnId;
      readonly stepId: StepId | null;
      readonly batchId: BatchId | null;
      readonly text: string;
    }
  | {
      readonly type: 'assistant-reasoning-delta';
      readonly turnId: TurnId;
      readonly stepId: StepId | null;
      readonly batchId: BatchId | null;
      readonly text: string;
    }
  | {
      readonly type: 'tool-call-started';
      readonly turnId: TurnId;
      readonly stepId: StepId | null;
      readonly batchId: BatchId | null;
      readonly toolName: string;
      readonly input: unknown;
    }
  | {
      readonly type: 'tool-call-finished';
      readonly turnId: TurnId;
      readonly stepId: StepId | null;
      readonly batchId: BatchId | null;
      readonly toolName: string;
      readonly input: unknown;
      readonly output: unknown;
    }
  | {
      readonly type: 'assistant-message-finalized';
      readonly turnId: TurnId;
      readonly finishReason: string;
    }
  | {
      readonly type: 'generate-turn-completed';
      readonly turnId: TurnId;
      readonly finishReason: string;
      readonly preview: string | null;
      readonly snapshot: SessionSnapshot;
    };

export type NarrativeSegmentFinalizedReason =
  | 'generate-complete'
  | 'signal-input-preflush'
  | 'step-reasoning'
  /**
   * narrative-rewrite 替换层落库的"权威"段（改进 B，2026-04-26）。
   *
   * rewrite applied=true 时，runRewriteIfEnabled 用 currentTurnRawText（包含
   * 主路径所有 onTextChunk，不被 preflush 切断）调 LLM 重写，输出**整个 turn**
   * 的合规版本，落库时 reason='rewrite-applied'。
   *
   * messages-builder 投影时遇到此 reason 的 segment：
   *   1. 跳过同 turnId 内**所有**其他 narrative-segment-finalized
   *   （含 'signal-input-preflush' 落的 prose 段、'generate-complete' 落的尾段）
   *   2. 只用 'rewrite-applied' 段的 content 投成 assistant message
   *
   * 这样 history 里 turn 内只剩 rewrite 后的 tagged 版本，下一轮 LLM 看到
   * 的 history 干净 —— 修复 trace 227cb1d0 暴露的 prose 污染下一轮
   * in-context 问题。
   */
  | 'rewrite-applied';

export type NarrativeCoreEvent =
  | {
      readonly type: 'narrative-batch-emitted';
      readonly turnId: TurnId;
      readonly batchId: BatchId | null;
      readonly sentences: readonly RuntimeSentence[];
      readonly scratches: readonly ScratchBlock[];
      readonly degrades: readonly DegradeEvent[];
      readonly sceneAfter: SceneState;
    }
  | {
      readonly type: 'narrative-segment-finalized';
      readonly turnId: TurnId;
      readonly stepId: StepId | null;
      readonly batchId: BatchId | null;
      readonly reason: NarrativeSegmentFinalizedReason;
      readonly entry: {
        readonly role: 'generate';
        readonly content: string;
        readonly reasoning?: string;
        readonly finishReason?: string;
      };
      readonly sceneAfter: SceneState;
    }
  | {
      readonly type: 'scene-changed';
      readonly turnId: TurnId;
      readonly batchId: BatchId | null;
      readonly scene: SceneState;
      readonly transition?: 'fade' | 'cut' | 'dissolve';
      readonly sentence: Extract<Sentence, { kind: 'scene_change' }>;
    };

export type InputCoreEvent =
  | {
      readonly type: 'signal-input-recorded';
      readonly turnId: TurnId;
      readonly batchId: BatchId | null;
      readonly request: InputRequest;
      readonly sentence: Extract<Sentence, { kind: 'signal_input' }>;
      readonly sceneAfter: SceneState;
    }
  | {
      readonly type: 'waiting-input-started';
      readonly turnId: TurnId;
      readonly requestId: InputRequestId;
      readonly source: 'signal' | 'fallback' | 'restore';
      readonly causedByBatchId: BatchId | null;
      readonly request: InputRequest;
      readonly snapshot: SessionSnapshot;
    }
  | {
      readonly type: 'player-input-recorded';
      readonly turnId: TurnId;
      readonly requestId: InputRequestId | null;
      readonly batchId: BatchId;
      readonly text: string;
      readonly payload: {
        readonly inputType: 'choice' | 'freetext';
        readonly selectedIndex?: number;
      };
      readonly sentence: Extract<Sentence, { kind: 'player_input' }>;
      readonly snapshot: SessionSnapshot;
    };

/**
 * ANN.1：每次 Memory.retrieve 的结果通过 retrieval-logger 包成此事件。
 * 客户端订阅后渲染 MemoryPanel。
 *
 * core 层只定义 shape，实际 emit 由 server 的 retrieval-logger 实现做。
 */
export interface MemoryRetrievalEntry {
  readonly id: string;
  readonly turn: number;
  readonly role: 'generate' | 'receive' | 'system';
  readonly content: string;
  readonly tokenCount: number;
  readonly timestamp: number;
  readonly tags?: readonly string[];
  readonly pinned?: boolean;
}

export type MemoryCoreEvent =
  | {
      readonly type: 'memory-compaction-started';
      readonly turnId: TurnId;
    }
  | {
      readonly type: 'memory-compaction-completed';
      readonly turnId: TurnId;
      readonly snapshot: SessionSnapshot;
    }
  | {
      readonly type: 'memory-retrieval';
      readonly retrievalId: string;
      readonly turn: number;
      readonly source: 'context-assembly' | 'tool-call';
      readonly query: string;
      readonly entries: readonly MemoryRetrievalEntry[];
      readonly summary: string;
    };

export type DiagnosticCoreEvent = {
  readonly type: 'diagnostics-updated';
  readonly diagnostics: DebugSnapshot;
};

/**
 * narrative-rewrite 阶段的事件。每轮主 LLM 路径完成后触发一次 rewrite call
 * 把 raw fullText 归一化成符合 IVN XML 协议的 tagged 输出。
 *
 * - rewrite-attempted：rewriter 即将启动（已通过 skip 检查）
 * - narrative-turn-reset：rewrite 成功 + 即将替换前发，告知 UI 清掉本 turn 的
 *   sentence 缓存（紧接着会有新一批 narrative-batch-emitted）
 * - rewrite-completed：rewriter 结束，含成功/fallback 状态、token 统计、失败原因
 *
 * PR1：仅记录不替换 → UI 不消费这三个事件，仅 trace + harness 用
 * PR2：开启替换 → narrative-segment-finalized.entry.content 落库版本是 rewritten；
 *      narrative-turn-reset 触发 UI 清 turn 缓存 + 重新接收 batch
 * PR3：UI stream raw 半透明 + rewrite-completed 触发揭开
 */
export type RewriteCoreEvent =
  | {
      readonly type: 'rewrite-attempted';
      readonly turnId: TurnId;
      readonly rawTextLength: number;
      /** parser 第一次跑完是否疑似不对劲（0 sentence / 有 degrade / 全 scratch） */
      readonly looksBroken: boolean;
    }
  | {
      readonly type: 'narrative-turn-reset';
      readonly turnId: TurnId;
      readonly reason: 'rewrite-applied';
      /** 重置后的 scene（rewrite replay 前的 turn 起始 scene） */
      readonly sceneAfter: SceneState;
    }
  | {
      readonly type: 'rewrite-completed';
      readonly turnId: TurnId;
      readonly status: 'ok' | 'skipped-empty' | 'skipped-aborted' | 'skipped-non-actionable' | 'fallback';
      readonly fallbackReason: 'api-error' | 'second-parse-failed' | 'rewrite-still-empty' | 'aborted' | null;
      readonly attempts: number;
      readonly latencyMs: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly model: string | null;
      /** rewrite 最终输出长度；skip / fallback to raw 时跟 rawTextLength 相同 */
      readonly outputTextLength: number;
      /** 二次 parser 校验产出的 sentence 数；skip 时为 null */
      readonly verifiedSentenceCount: number | null;
      /** rewrite 是否真的替换了 currentNarrativeBuffer（仅 status='ok' + 文本不同时为 true） */
      readonly applied: boolean;
    };

export type CoreEvent =
  | SessionCoreEvent
  | GenerateCoreEvent
  | NarrativeCoreEvent
  | InputCoreEvent
  | MemoryCoreEvent
  | RewriteCoreEvent
  | DiagnosticCoreEvent;

export interface CoreEventEnvelope {
  readonly schemaVersion: 1;
  readonly sequence: number;
  readonly occurredAt: number;
  readonly playthroughId: string;
  readonly event: CoreEvent;
}

export interface CoreEventSink {
  publish(event: CoreEvent): void;
  flushDurable?(): Promise<void>;
}

export interface CoreEventBus extends CoreEventSink {
  flushDurable(): Promise<void>;
}

export interface DurableFirstCoreEventSinkOptions {
  readonly durableSinks: readonly CoreEventSink[];
  readonly realtimeSinks?: readonly CoreEventSink[];
  readonly isDurableEvent: (event: CoreEvent) => boolean;
  readonly onError?: (error: unknown, event: CoreEvent) => void;
}

export function createCoreEventBus(sinks: readonly CoreEventSink[] = []): CoreEventBus {
  return {
    publish(event) {
      for (const sink of sinks) {
        sink.publish(event);
      }
    },
    async flushDurable() {
      await Promise.all(sinks.map((sink) => sink.flushDurable?.()));
    },
  };
}

export function createDurableFirstCoreEventSink(
  options: DurableFirstCoreEventSinkOptions,
): CoreEventBus {
  const realtimeSinks = options.realtimeSinks ?? [];
  const onError = options.onError ?? logCoreEventSinkError;
  let tail = Promise.resolve();

  const enqueue = (event: CoreEvent, work: () => Promise<void>) => {
    tail = tail.then(work).catch((error) => onError(error, event));
  };

  return {
    publish(event) {
      enqueue(event, async () => {
        if (options.isDurableEvent(event)) {
          for (const sink of options.durableSinks) {
            sink.publish(event);
          }
          await Promise.all(options.durableSinks.map((sink) => sink.flushDurable?.()));
        }

        for (const sink of realtimeSinks) {
          sink.publish(event);
        }
        await Promise.all(realtimeSinks.map((sink) => sink.flushDurable?.()));
      });
    },

    async flushDurable() {
      await tail;
      await Promise.all([
        ...options.durableSinks.map((sink) => sink.flushDurable?.()),
        ...realtimeSinks.map((sink) => sink.flushDurable?.()),
      ]);
    },
  };
}

export function createNoopCoreEventSink(): CoreEventSink {
  return { publish() {} };
}

function logCoreEventSinkError(error: unknown, event: CoreEvent): void {
  console.error(`[CoreEventSink] ${event.type} failed:`, error);
}

export function turnId(turn: number): TurnId {
  return `turn-${turn}` as TurnId;
}

export function stepId(turn: number, stepNumber: number): StepId {
  return `turn-${turn}-step-${stepNumber}` as StepId;
}

export function batchId(value: string | null | undefined): BatchId | null {
  return value ? (value as BatchId) : null;
}

export function inputRequestId(turn: number): InputRequestId {
  return `turn-${turn}-input` as InputRequestId;
}

export function createInputRequest(
  hint: string | null,
  choices: readonly string[] | null,
): InputRequest {
  return choices && choices.length > 0
    ? { inputType: 'choice', hint, choices: [...choices] }
    : { inputType: 'freetext', hint, choices: null };
}
