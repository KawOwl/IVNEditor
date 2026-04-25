import type {
  CoreEvent,
  CoreEventSink,
  SessionSnapshot,
} from '#internal/game-session/core-events';
import type {
  RecordedEntry,
  RecordedInputRequest,
  RecordedPendingDebug,
  RecordedSceneChange,
  RecordedSessionOutput,
  RecordedStreamingEntry,
} from '#internal/game-session/recording-emitter';
import type {
  ParticipationFrame,
  PromptSnapshot,
  SceneState,
  Sentence,
  ToolCallEntry,
} from '#internal/types';

type InputType = RecordedSessionOutput['inputType'];
type SessionStatus = NonNullable<RecordedSessionOutput['status']>;
type DebugSnapshot = RecordedSessionOutput['debugSnapshots'][number];
type CoreEventOf<T extends CoreEvent['type']> = Extract<CoreEvent, { readonly type: T }>;

export interface RecordingSessionOutputSink extends CoreEventSink {
  getSnapshot(): RecordedSessionOutput;
  reset(): void;
}

interface MutableRecordedSessionOutput {
  status: SessionStatus | null;
  error: string | null;
  inputHint: string | null;
  inputType: InputType;
  choices: string[] | null;
  statuses: SessionStatus[];
  errors: Array<string | null>;
  streamingEntries: RecordedStreamingEntry[];
  entries: RecordedEntry[];
  toolCalls: ToolCallEntry[];
  pendingToolCalls: ToolCallEntry[];
  inputRequests: RecordedInputRequest[];
  pendingDebug: RecordedPendingDebug[];
  debugSnapshots: DebugSnapshot[];
  sentences: Sentence[];
  sceneChanges: RecordedSceneChange[];
}

export function createRecordingSessionOutputSink(): RecordingSessionOutputSink {
  let output = createEmptyOutput();
  let streamSeq = 0;
  let currentStreamingId: string | null = null;

  const reset = () => {
    output = createEmptyOutput();
    streamSeq = 0;
    currentStreamingId = null;
  };

  const startStreamingEntry = (): RecordedStreamingEntry => {
    streamSeq += 1;
    const entry = {
      id: `recording-stream-${streamSeq}`,
      text: '',
      reasoning: '',
      finalized: false,
    };
    output.streamingEntries.push(entry);
    currentStreamingId = entry.id;
    return entry;
  };

  const getCurrentStreamingEntry = () => {
    const current = output.streamingEntries.find((entry) => entry.id === currentStreamingId);
    if (current) return current;

    const last = output.streamingEntries.at(-1);
    return last && !last.finalized ? last : null;
  };

  const ensureStreamingEntry = () => getCurrentStreamingEntry() ?? startStreamingEntry();

  const updateCurrentStreamingEntry = (patch: Partial<RecordedStreamingEntry>) => {
    const entry = getCurrentStreamingEntry();
    if (!entry) return;

    const index = output.streamingEntries.findIndex((candidate) => candidate.id === entry.id);
    if (index < 0) return;

    output.streamingEntries[index] = { ...entry, ...patch };
  };

  const setStatus = (status: SessionStatus) => {
    output.status = status;
    output.statuses.push(status);
    if (status === 'waiting-input') {
      output.inputRequests.push({
        hint: output.inputHint,
        inputType: output.inputType,
        choices: copyChoices(output.choices),
      });
    }
  };

  const appendSentence = (sentence: Sentence) => {
    output.sentences.push(copySentence(sentence));
  };

  const emitSceneChange = (
    scene: SceneState,
    transition?: RecordedSceneChange['transition'],
  ) => {
    output.sceneChanges.push({
      scene: copyScene(scene),
      ...(transition !== undefined ? { transition } : {}),
    });
  };

  const updateToolCall = (calls: ToolCallEntry[], name: string, result: unknown) => {
    const index = calls.findLastIndex((entry) => entry.name === name);
    const entry = calls[index];
    if (index < 0 || !entry) return;

    calls[index] = { ...entry, result };
  };

  const publish = (event: CoreEvent) => {
    switch (event.type) {
      case 'session-started':
        recordSessionStarted(event);
        return;
      case 'session-restored':
        recordSessionRestored(event);
        return;
      case 'session-stopped':
        setStatus('idle');
        return;
      case 'session-finished':
        recordSessionFinished(event);
        return;
      case 'session-error':
        recordSessionError(event);
        return;
      case 'generate-turn-started':
        setStatus('generating');
        return;
      case 'context-assembled':
        recordContextAssembled(event);
        return;
      case 'assistant-message-started':
        startStreamingEntry();
        return;
      case 'llm-step-started':
        return;
      case 'assistant-text-delta':
        appendStreamingText(event);
        return;
      case 'assistant-reasoning-delta':
        appendStreamingReasoning(event);
        return;
      case 'tool-call-started':
        recordToolCallStarted(event);
        return;
      case 'tool-call-finished':
        recordToolCallFinished(event);
        return;
      case 'assistant-message-finalized':
        recordAssistantMessageFinalized(event);
        return;
      case 'generate-turn-completed':
        return;
      case 'narrative-batch-emitted':
        recordNarrativeBatch(event);
        return;
      case 'narrative-segment-finalized':
        return;
      case 'scene-changed':
        recordSceneChanged(event);
        return;
      case 'signal-input-recorded':
        appendSentence(event.sentence);
        return;
      case 'waiting-input-started':
        recordWaitingInputStarted(event);
        return;
      case 'player-input-recorded':
        recordPlayerInput(event);
        return;
      case 'memory-compaction-started':
        setStatus('compressing');
        return;
      case 'memory-compaction-completed':
        return;
      case 'diagnostics-updated':
        output.debugSnapshots.push(copyDebugSnapshot(event.diagnostics));
        return;
    }
  };

  function recordSessionStarted(event: CoreEventOf<'session-started'>): void {
    reset();
    setStatus('loading');
    recordSnapshot(event.snapshot, output);
  }

  function recordSessionRestored(event: CoreEventOf<'session-restored'>): void {
    setStatus('loading');
    recordSnapshot(event.snapshot, output);
    if (event.restoredFrom === 'finished') {
      setStatus('finished');
    }
  }

  function recordSessionFinished(event: CoreEventOf<'session-finished'>): void {
    setStatus('finished');
    output.debugSnapshots.push(createDebugSnapshot(event.snapshot));
  }

  function recordSessionError(event: CoreEventOf<'session-error'>): void {
    if (event.phase === 'generate') {
      updateCurrentStreamingEntry({ finalized: true });
      currentStreamingId = null;
    }
    output.error = event.message;
    output.errors.push(event.message);
  }

  function recordContextAssembled(event: CoreEventOf<'context-assembled'>): void {
    const { promptSnapshot } = event;
    output.debugSnapshots.push({
      tokenBreakdown: copyTokenBreakdown(promptSnapshot.tokenBreakdown),
      assembledSystemPrompt: promptSnapshot.systemPrompt,
      assembledMessages: promptSnapshot.messages.map((message) => ({ ...message })),
      activeSegmentIds: [...promptSnapshot.activeSegmentIds],
    });
    output.pendingDebug.push({
      promptSnapshot: copyPromptSnapshot(promptSnapshot),
    });
  }

  function appendStreamingText(event: CoreEventOf<'assistant-text-delta'>): void {
    const entry = ensureStreamingEntry();
    updateCurrentStreamingEntry({ text: entry.text + event.text });
  }

  function appendStreamingReasoning(
    event: CoreEventOf<'assistant-reasoning-delta'>,
  ): void {
    const entry = ensureStreamingEntry();
    updateCurrentStreamingEntry({ reasoning: entry.reasoning + event.text });
  }

  function recordToolCallStarted(event: CoreEventOf<'tool-call-started'>): void {
    const entry = {
      name: event.toolName,
      args: event.input,
      result: undefined,
      timestamp: Date.now(),
    };
    output.toolCalls.push({ ...entry });
    output.pendingToolCalls.push({ ...entry });
  }

  function recordToolCallFinished(event: CoreEventOf<'tool-call-finished'>): void {
    updateToolCall(output.toolCalls, event.toolName, event.output);
    updateToolCall(output.pendingToolCalls, event.toolName, event.output);
  }

  function recordAssistantMessageFinalized(
    event: CoreEventOf<'assistant-message-finalized'>,
  ): void {
    output.pendingDebug.push({ finishReason: event.finishReason });
    updateCurrentStreamingEntry({ finalized: true });
    currentStreamingId = null;
  }

  function recordNarrativeBatch(event: CoreEventOf<'narrative-batch-emitted'>): void {
    for (const sentence of event.sentences) {
      appendSentence(sentence);
    }
  }

  function recordSceneChanged(event: CoreEventOf<'scene-changed'>): void {
    emitSceneChange(event.scene, event.transition);
    appendSentence(event.sentence);
  }

  function recordWaitingInputStarted(
    event: CoreEventOf<'waiting-input-started'>,
  ): void {
    output.inputHint = event.request.hint;
    output.inputType = event.request.inputType;
    output.choices = event.request.inputType === 'choice'
      ? [...event.request.choices]
      : null;
    setStatus('waiting-input');
  }

  function recordPlayerInput(event: CoreEventOf<'player-input-recorded'>): void {
    output.error = null;
    output.errors.push(null);
    output.entries.push({ role: 'receive', content: event.text });
    appendSentence(event.sentence);
    output.inputHint = null;
    output.inputType = 'freetext';
    output.choices = null;
  }

  return {
    publish,
    getSnapshot: () => copyOutput(output),
    reset,
  };
}

function createEmptyOutput(): MutableRecordedSessionOutput {
  return {
    status: null,
    error: null,
    inputHint: null,
    inputType: 'freetext',
    choices: null,
    statuses: [],
    errors: [],
    streamingEntries: [],
    entries: [],
    toolCalls: [],
    pendingToolCalls: [],
    inputRequests: [],
    pendingDebug: [],
    debugSnapshots: [],
    sentences: [],
    sceneChanges: [],
  };
}

function recordSnapshot(
  snapshot: SessionSnapshot,
  output: MutableRecordedSessionOutput,
): void {
  output.sceneChanges.push({ scene: copyScene(snapshot.currentScene) });
  output.debugSnapshots.push(createDebugSnapshot(snapshot));
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

const copyChoices = (choices: readonly string[] | null): string[] | null =>
  choices ? [...choices] : null;

const copyToolCall = (entry: ToolCallEntry): ToolCallEntry => ({ ...entry });

const copyScene = (scene: SceneState): SceneState => ({
  background: scene.background,
  sprites: scene.sprites.map((sprite) => ({ ...sprite })),
});

const copyParticipationFrame = (pf: ParticipationFrame): ParticipationFrame => ({
  speaker: pf.speaker,
  ...(pf.addressee ? { addressee: [...pf.addressee] } : {}),
  ...(pf.overhearers ? { overhearers: [...pf.overhearers] } : {}),
  ...(pf.eavesdroppers ? { eavesdroppers: [...pf.eavesdroppers] } : {}),
});

const copySentence = (sentence: Sentence): Sentence => {
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
};

const copyPromptSnapshot = (snapshot: PromptSnapshot): PromptSnapshot => ({
  systemPrompt: snapshot.systemPrompt,
  messages: snapshot.messages.map((message) => ({ ...message })),
  tokenBreakdown: copyTokenBreakdown(snapshot.tokenBreakdown),
  activeSegmentIds: [...snapshot.activeSegmentIds],
});

const copyTokenBreakdown = (
  tokenBreakdown: PromptSnapshot['tokenBreakdown'],
): PromptSnapshot['tokenBreakdown'] => ({ ...tokenBreakdown });

const copyPendingDebug = (info: RecordedPendingDebug): RecordedPendingDebug => ({
  ...(info.promptSnapshot ? { promptSnapshot: copyPromptSnapshot(info.promptSnapshot) } : {}),
  ...(info.finishReason !== undefined ? { finishReason: info.finishReason } : {}),
});

const copyDebugSnapshot = (debug: DebugSnapshot): DebugSnapshot => ({
  ...debug,
  ...(debug.tokenBreakdown !== undefined
    ? { tokenBreakdown: debug.tokenBreakdown ? { ...debug.tokenBreakdown } : null }
    : {}),
  ...(debug.memoryEntries
    ? { memoryEntries: debug.memoryEntries.map((entry) => ({ ...entry })) }
    : {}),
  ...(debug.memorySummaries ? { memorySummaries: [...debug.memorySummaries] } : {}),
  ...(debug.changelogEntries
    ? { changelogEntries: debug.changelogEntries.map((entry) => ({ ...entry })) }
    : {}),
  ...(debug.assembledMessages
    ? { assembledMessages: debug.assembledMessages.map((message) => ({ ...message })) }
    : {}),
  ...(debug.activeSegmentIds ? { activeSegmentIds: [...debug.activeSegmentIds] } : {}),
});

const copyOutput = (output: MutableRecordedSessionOutput): RecordedSessionOutput => ({
  status: output.status,
  error: output.error,
  inputHint: output.inputHint,
  inputType: output.inputType,
  choices: copyChoices(output.choices),
  statuses: [...output.statuses],
  errors: [...output.errors],
  streamingEntries: output.streamingEntries.map((entry) => ({ ...entry })),
  entries: output.entries.map((entry) => ({ ...entry })),
  toolCalls: output.toolCalls.map(copyToolCall),
  pendingToolCalls: output.pendingToolCalls.map(copyToolCall),
  inputRequests: output.inputRequests.map((request) => ({
    hint: request.hint,
    inputType: request.inputType,
    choices: copyChoices(request.choices),
  })),
  pendingDebug: output.pendingDebug.map(copyPendingDebug),
  debugSnapshots: output.debugSnapshots.map(copyDebugSnapshot),
  sentences: output.sentences.map(copySentence),
  sceneChanges: output.sceneChanges.map((change) => ({
    scene: copyScene(change.scene),
    ...(change.transition !== undefined ? { transition: change.transition } : {}),
  })),
});
