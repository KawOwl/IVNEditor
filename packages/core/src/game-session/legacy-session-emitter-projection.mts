import type { CoreEvent, SessionSnapshot } from '#internal/game-session/core-events';
import type { DebugSnapshot, SessionEmitter } from '#internal/legacy-session-emitter';
import type {
  ParticipationFrame,
  PromptSnapshot,
  SceneState,
  Sentence,
  TokenBreakdownInfo,
} from '#internal/types';

type CoreEventOf<T extends CoreEvent['type']> = Extract<CoreEvent, { readonly type: T }>;
type ProjectionHandlers = {
  readonly [K in CoreEvent['type']]: (
    event: CoreEventOf<K>,
    emitter: SessionEmitter,
  ) => void;
};

export interface LegacySessionEmitterProjection {
  publish(event: CoreEvent): void;
}

export function createLegacySessionEmitterProjection(
  emitter: SessionEmitter,
): LegacySessionEmitterProjection {
  return {
    publish(event) {
      projectCoreEventToLegacySessionEmitter(event, emitter);
    },
  };
}

export function projectCoreEventToLegacySessionEmitter(
  event: CoreEvent,
  emitter: SessionEmitter,
): void {
  const handler = projectionHandlers[event.type] as (
    event: CoreEvent,
    emitter: SessionEmitter,
  ) => void;
  handler(event, emitter);
}

const projectionHandlers: ProjectionHandlers = {
  'session-started': projectSessionStarted,
  'session-restored': projectSessionRestored,
  'session-stopped': projectSessionStopped,
  'session-finished': projectSessionFinished,
  'session-error': projectSessionError,
  'generate-turn-started': projectGenerateTurnStarted,
  'context-assembled': projectContextAssembled,
  'assistant-message-started': projectAssistantMessageStarted,
  'llm-step-started': ignoreEvent,
  'assistant-text-delta': projectAssistantTextDelta,
  'assistant-reasoning-delta': projectAssistantReasoningDelta,
  'tool-call-started': projectToolCallStarted,
  'tool-call-finished': projectToolCallFinished,
  'assistant-message-finalized': projectAssistantMessageFinalized,
  'generate-turn-completed': ignoreEvent,
  'narrative-batch-emitted': projectNarrativeBatch,
  'narrative-segment-finalized': ignoreEvent,
  'scene-changed': projectSceneChanged,
  'signal-input-recorded': projectSignalInputRecorded,
  'waiting-input-started': projectWaitingInputStarted,
  'player-input-recorded': projectPlayerInputRecorded,
  'memory-compaction-started': projectMemoryCompactionStarted,
  'memory-compaction-completed': ignoreEvent,
  // ANN.1：legacy emitter 不消费 retrieval 事件 —— 直接由 ws-core-event-sink
  // 转成 WS message 给客户端 game-store。
  'memory-retrieval': ignoreEvent,
  // PR1：rewrite 事件仅 observability，legacy emitter 不消费。PR2 起会用
  // 这俩事件驱动 UI 遮罩 / reveal 状态。
  'rewrite-attempted': ignoreEvent,
  'rewrite-completed': ignoreEvent,
  'narrative-turn-reset': ignoreEvent,
  'diagnostics-updated': projectDiagnosticsUpdated,
};

function ignoreEvent(): void {}

function projectSessionStarted(
  event: CoreEventOf<'session-started'>,
  emitter: SessionEmitter,
): void {
  emitter.reset();
  emitter.setStatus('loading');
  projectSessionSnapshot(event.snapshot, emitter);
}

function projectSessionRestored(
  event: CoreEventOf<'session-restored'>,
  emitter: SessionEmitter,
): void {
  emitter.setStatus('loading');
  projectSessionSnapshot(event.snapshot, emitter);
  if (event.restoredFrom === 'finished') {
    emitter.setStatus('finished');
  }
}

function projectSessionFinished(
  event: CoreEventOf<'session-finished'>,
  emitter: SessionEmitter,
): void {
  emitter.setStatus('finished');
  emitter.updateDebug(createDebugSnapshot(event.snapshot));
}

function projectSessionStopped(
  _event: CoreEventOf<'session-stopped'>,
  emitter: SessionEmitter,
): void {
  emitter.setStatus('idle');
}

function projectSessionError(
  event: CoreEventOf<'session-error'>,
  emitter: SessionEmitter,
): void {
  if (event.phase === 'generate') {
    emitter.finalizeStreamingEntry();
  }
  emitter.setError(event.message);
}

function projectGenerateTurnStarted(
  _event: CoreEventOf<'generate-turn-started'>,
  emitter: SessionEmitter,
): void {
  emitter.setStatus('generating');
}

function projectSessionSnapshot(
  snapshot: SessionSnapshot,
  emitter: SessionEmitter,
): void {
  emitter.emitSceneChange(copyScene(snapshot.currentScene));
  emitter.updateDebug(createDebugSnapshot(snapshot));
}

function projectContextAssembled(
  event: CoreEventOf<'context-assembled'>,
  emitter: SessionEmitter,
): void {
  emitter.updateDebug({
    tokenBreakdown: copyTokenBreakdown(event.promptSnapshot.tokenBreakdown),
    assembledSystemPrompt: event.promptSnapshot.systemPrompt,
    assembledMessages: event.promptSnapshot.messages.map((message) => ({ ...message })),
    activeSegmentIds: [...event.promptSnapshot.activeSegmentIds],
  });
  emitter.stagePendingDebug({ promptSnapshot: copyPromptSnapshot(event.promptSnapshot) });
}

function projectAssistantMessageStarted(
  _event: CoreEventOf<'assistant-message-started'>,
  emitter: SessionEmitter,
): void {
  emitter.beginStreamingEntry();
}

function projectAssistantTextDelta(
  event: CoreEventOf<'assistant-text-delta'>,
  emitter: SessionEmitter,
): void {
  emitter.appendToStreamingEntry(event.text);
}

function projectAssistantReasoningDelta(
  event: CoreEventOf<'assistant-reasoning-delta'>,
  emitter: SessionEmitter,
): void {
  emitter.appendReasoningToStreamingEntry(event.text);
}

function projectToolCallStarted(
  event: CoreEventOf<'tool-call-started'>,
  emitter: SessionEmitter,
): void {
  const entry = { name: event.toolName, args: event.input, result: undefined };
  emitter.addToolCall(entry);
  emitter.addPendingToolCall(entry);
}

function projectToolCallFinished(
  event: CoreEventOf<'tool-call-finished'>,
  emitter: SessionEmitter,
): void {
  emitter.updateToolResult(event.toolName, event.output);
  emitter.updatePendingToolResult(event.toolName, event.output);
}

function projectAssistantMessageFinalized(
  event: CoreEventOf<'assistant-message-finalized'>,
  emitter: SessionEmitter,
): void {
  emitter.stagePendingDebug({ finishReason: event.finishReason });
  emitter.finalizeStreamingEntry();
}

function projectNarrativeBatch(
  event: CoreEventOf<'narrative-batch-emitted'>,
  emitter: SessionEmitter,
): void {
  for (const sentence of event.sentences) {
    emitter.appendSentence(copySentence(sentence));
  }
}

function projectSceneChanged(
  event: CoreEventOf<'scene-changed'>,
  emitter: SessionEmitter,
): void {
  emitter.emitSceneChange(copyScene(event.scene), event.transition);
  emitter.appendSentence(copySentence(event.sentence));
}

function projectSignalInputRecorded(
  event: CoreEventOf<'signal-input-recorded'>,
  emitter: SessionEmitter,
): void {
  emitter.appendSentence(copySentence(event.sentence));
}

function projectWaitingInputStarted(
  event: CoreEventOf<'waiting-input-started'>,
  emitter: SessionEmitter,
): void {
  emitter.setInputHint(event.request.hint);
  emitter.setInputType(
    event.request.inputType,
    event.request.inputType === 'choice' ? [...event.request.choices] : null,
  );
  emitter.setStatus('waiting-input');
}

function projectPlayerInputRecorded(
  event: CoreEventOf<'player-input-recorded'>,
  emitter: SessionEmitter,
): void {
  emitter.setError(null);
  emitter.appendEntry({ role: 'receive', content: event.text });
  emitter.appendSentence(copySentence(event.sentence));
  emitter.setInputHint(null);
  emitter.setInputType('freetext');
}

function projectMemoryCompactionStarted(
  _event: CoreEventOf<'memory-compaction-started'>,
  emitter: SessionEmitter,
): void {
  emitter.setStatus('compressing');
}

function projectDiagnosticsUpdated(
  event: CoreEventOf<'diagnostics-updated'>,
  emitter: SessionEmitter,
): void {
  emitter.updateDebug(event.diagnostics);
}

function createDebugSnapshot(snapshot: SessionSnapshot): DebugSnapshot {
  const memorySnapshot = snapshot.memorySnapshot;
  const entries = Array.isArray(memorySnapshot?.entries) ? memorySnapshot.entries : [];
  const summaries = Array.isArray(memorySnapshot?.summaries) ? memorySnapshot.summaries : [];
  return {
    stateVars: { ...snapshot.stateVars },
    totalTurns: snapshot.turn,
    memoryEntryCount: entries.length,
    memorySummaryCount: summaries.length,
  };
}

function copyPromptSnapshot(snapshot: PromptSnapshot): PromptSnapshot {
  return {
    systemPrompt: snapshot.systemPrompt,
    messages: snapshot.messages.map((message) => ({ ...message })),
    tokenBreakdown: copyTokenBreakdown(snapshot.tokenBreakdown),
    activeSegmentIds: [...snapshot.activeSegmentIds],
  };
}

function copyTokenBreakdown(tokenBreakdown: TokenBreakdownInfo): TokenBreakdownInfo {
  return { ...tokenBreakdown };
}

function copyScene(scene: SceneState): SceneState {
  return {
    background: scene.background,
    sprites: scene.sprites.map((sprite) => ({ ...sprite })),
  };
}

function copyParticipationFrame(pf: ParticipationFrame): ParticipationFrame {
  return {
    speaker: pf.speaker,
    ...(pf.addressee ? { addressee: [...pf.addressee] } : {}),
    ...(pf.overhearers ? { overhearers: [...pf.overhearers] } : {}),
    ...(pf.eavesdroppers ? { eavesdroppers: [...pf.eavesdroppers] } : {}),
  };
}

function copySentence(sentence: Sentence): Sentence {
  if (sentence.kind === 'narration') {
    return { ...sentence, sceneRef: copyScene(sentence.sceneRef) };
  }

  if (sentence.kind === 'dialogue') {
    return {
      ...sentence,
      pf: copyParticipationFrame(sentence.pf),
      sceneRef: copyScene(sentence.sceneRef),
    };
  }

  if (sentence.kind === 'scene_change') {
    return { ...sentence, scene: copyScene(sentence.scene) };
  }

  return { ...sentence, sceneRef: copyScene(sentence.sceneRef) };
}
