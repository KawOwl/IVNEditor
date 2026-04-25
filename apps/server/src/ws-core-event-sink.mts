/**
 * WebSocket CoreEvent sink
 *
 * Serializes runtime CoreEvents to the existing WebSocket message protocol.
 * This keeps the client wire format stable without routing through the legacy
 * SessionEmitter projection.
 */

import type {
  CoreEvent,
  CoreEventSink,
  SessionSnapshot,
} from '@ivn/core/game-session';
import type {
  ParticipationFrame,
  PromptSnapshot,
  SceneState,
  Sentence,
  TokenBreakdownInfo,
} from '@ivn/core/types';

type WS = { send(data: string): void };
type CoreEventOf<T extends CoreEvent['type']> = Extract<CoreEvent, { readonly type: T }>;
type WebSocketCoreEventHandlers = {
  readonly [K in CoreEvent['type']]: (
    event: CoreEventOf<K>,
    context: WebSocketSinkContext,
  ) => void;
};

interface WebSocketSinkContext {
  readonly enableDebug: boolean;
  emit(type: string, payload?: Record<string, unknown>): void;
}

export function createWebSocketCoreEventSink(
  ws: WS,
  options?: { enableDebug?: boolean },
): CoreEventSink {
  const context: WebSocketSinkContext = {
    enableDebug: options?.enableDebug ?? false,
    emit(type, payload) {
      try {
        ws.send(JSON.stringify(payload ? { type, ...payload } : { type }));
      } catch {
        // WebSocket might be closed.
      }
    },
  };

  return {
    publish(event) {
      const handler = websocketCoreEventHandlers[event.type] as (
        event: CoreEvent,
        context: WebSocketSinkContext,
      ) => void;
      handler(event, context);
    },
  };
}

const websocketCoreEventHandlers: WebSocketCoreEventHandlers = {
  'session-started': (event, context) => {
    context.emit('reset');
    context.emit('status', { status: 'loading' });
    emitSessionSnapshot(context, event.snapshot);
  },

  'session-restored': (event, context) => {
    context.emit('status', { status: 'loading' });
    emitSessionSnapshot(context, event.snapshot);
    if (event.restoredFrom === 'finished') {
      context.emit('status', { status: 'finished' });
    }
  },

  'session-stopped': (_event, context) => {
    context.emit('status', { status: 'idle' });
  },

  'session-finished': (event, context) => {
    context.emit('status', { status: 'finished' });
    emitDebug(context, createDebugSnapshot(event.snapshot));
  },

  'session-error': (event, context) => {
    if (event.phase === 'generate') {
      context.emit('finalize');
    }
    context.emit('error', { error: event.message });
  },

  'generate-turn-started': (_event, context) => {
    context.emit('status', { status: 'generating' });
  },

  'context-assembled': (event, context) => {
    emitDebug(context, {
      tokenBreakdown: copyTokenBreakdown(event.promptSnapshot.tokenBreakdown),
      assembledSystemPrompt: event.promptSnapshot.systemPrompt,
      assembledMessages: event.promptSnapshot.messages.map((message) => ({ ...message })),
      activeSegmentIds: [...event.promptSnapshot.activeSegmentIds],
    });
    emitDebug(context, {
      promptSnapshot: copyPromptSnapshot(event.promptSnapshot),
    }, 'stage-pending-debug');
  },

  'assistant-message-started': (_event, context) => {
    context.emit('begin-streaming');
  },

  'llm-step-started': ignoreEvent,

  'assistant-text-delta': (event, context) => {
    context.emit('text-chunk', { text: event.text });
  },

  'assistant-reasoning-delta': (event, context) => {
    context.emit('reasoning-chunk', { text: event.text });
  },

  'tool-call-started': (event, context) => {
    context.emit('tool-call', { name: event.toolName, args: event.input });
    context.emit('pending-tool-call', { name: event.toolName, args: event.input });
  },

  'tool-call-finished': (event, context) => {
    context.emit('tool-result', { name: event.toolName, result: event.output });
    context.emit('pending-tool-result', { name: event.toolName, result: event.output });
  },

  'assistant-message-finalized': (event, context) => {
    emitDebug(context, { finishReason: event.finishReason }, 'stage-pending-debug');
    context.emit('finalize');
  },

  'generate-turn-completed': ignoreEvent,

  'narrative-batch-emitted': (event, context) => {
    for (const sentence of event.sentences) {
      context.emit('sentence', { sentence: copySentence(sentence) });
    }
  },

  'narrative-segment-finalized': ignoreEvent,

  'scene-changed': (event, context) => {
    context.emit('scene-change', {
      scene: copyScene(event.scene),
      transition: event.transition,
    });
    context.emit('sentence', { sentence: copySentence(event.sentence) });
  },

  'signal-input-recorded': (event, context) => {
    context.emit('sentence', { sentence: copySentence(event.sentence) });
  },

  'waiting-input-started': (event, context) => {
    context.emit('input-hint', { hint: event.request.hint });
    context.emit('input-type', {
      inputType: event.request.inputType,
      choices: event.request.inputType === 'choice' ? [...event.request.choices] : null,
    });
    context.emit('status', { status: 'waiting-input' });
  },

  'player-input-recorded': (event, context) => {
    context.emit('error', { error: null });
    context.emit('entry', { entry: { role: 'receive', content: event.text } });
    context.emit('sentence', { sentence: copySentence(event.sentence) });
    context.emit('input-hint', { hint: null });
    context.emit('input-type', { inputType: 'freetext' });
  },

  'memory-compaction-started': (_event, context) => {
    context.emit('status', { status: 'compressing' });
  },

  'memory-compaction-completed': ignoreEvent,

  'diagnostics-updated': (event, context) => {
    emitDebug(context, { ...event.diagnostics });
  },
};

function ignoreEvent(): void {}

function emitSessionSnapshot(context: WebSocketSinkContext, snapshot: SessionSnapshot): void {
  context.emit('scene-change', { scene: copyScene(snapshot.currentScene) });
  emitDebug(context, createDebugSnapshot(snapshot));
}

function emitDebug(
  context: WebSocketSinkContext,
  payload: Record<string, unknown>,
  type = 'update-debug',
): void {
  if (!context.enableDebug) return;
  context.emit(type, payload);
}

function createDebugSnapshot(snapshot: SessionSnapshot): Record<string, unknown> {
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
