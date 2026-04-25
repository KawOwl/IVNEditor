/**
 * RecordingSessionEmitter
 *
 * A view-independent legacy SessionEmitter for tests, backend jobs, and
 * evaluation harnesses. It consumes projected CoreEvents without WebSocket,
 * Zustand, or DOM.
 */

import type { DebugSnapshot, SessionEmitter, SessionStatus } from '#internal/legacy-session-emitter';
import type {
  ParticipationFrame,
  PromptSnapshot,
  SceneState,
  Sentence,
  ToolCallEntry,
} from '#internal/types';

type InputType = 'freetext' | 'choice';
type EntryRole = 'generate' | 'receive' | 'system';
type SceneTransition = 'fade' | 'cut' | 'dissolve';

export interface RecordedStreamingEntry {
  readonly id: string;
  readonly text: string;
  readonly reasoning: string;
  readonly finalized: boolean;
}

export interface RecordedEntry {
  readonly role: EntryRole;
  readonly content: string;
}

export interface RecordedInputRequest {
  readonly hint: string | null;
  readonly inputType: InputType;
  readonly choices: readonly string[] | null;
}

export interface RecordedSceneChange {
  readonly scene: SceneState;
  readonly transition?: SceneTransition;
}

export interface RecordedPendingDebug {
  readonly promptSnapshot?: PromptSnapshot;
  readonly finishReason?: string;
}

export interface RecordedSessionOutput {
  readonly status: SessionStatus | null;
  readonly error: string | null;
  readonly inputHint: string | null;
  readonly inputType: InputType;
  readonly choices: readonly string[] | null;
  readonly statuses: readonly SessionStatus[];
  readonly errors: readonly (string | null)[];
  readonly streamingEntries: readonly RecordedStreamingEntry[];
  readonly entries: readonly RecordedEntry[];
  readonly toolCalls: readonly ToolCallEntry[];
  readonly pendingToolCalls: readonly ToolCallEntry[];
  readonly inputRequests: readonly RecordedInputRequest[];
  readonly pendingDebug: readonly RecordedPendingDebug[];
  readonly debugSnapshots: readonly DebugSnapshot[];
  readonly sentences: readonly Sentence[];
  readonly sceneChanges: readonly RecordedSceneChange[];
}

export interface RecordingSessionEmitter {
  readonly emitter: SessionEmitter;
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

const createEmptyOutput = (): MutableRecordedSessionOutput => ({
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
});

export function createRecordingSessionEmitter(): RecordingSessionEmitter {
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

  const updateToolCall = (calls: ToolCallEntry[], name: string, result: unknown) => {
    const index = calls.findLastIndex((entry) => entry.name === name);
    const entry = calls[index];
    if (index < 0 || !entry) return;

    calls[index] = { ...entry, result };
  };

  const recordInputRequest = () => {
    output.inputRequests.push({
      hint: output.inputHint,
      inputType: output.inputType,
      choices: copyChoices(output.choices),
    });
  };

  const emitter: SessionEmitter = {
    reset,

    setStatus(status) {
      output.status = status;
      output.statuses.push(status);
      if (status === 'waiting-input') {
        recordInputRequest();
      }
    },

    setError(error) {
      output.error = error;
      output.errors.push(error);
    },

    beginStreamingEntry() {
      return startStreamingEntry().id;
    },

    appendToStreamingEntry(text) {
      const entry = ensureStreamingEntry();
      updateCurrentStreamingEntry({ text: entry.text + text });
    },

    appendReasoningToStreamingEntry(reasoning) {
      const entry = ensureStreamingEntry();
      updateCurrentStreamingEntry({ reasoning: entry.reasoning + reasoning });
    },

    finalizeStreamingEntry() {
      updateCurrentStreamingEntry({ finalized: true });
      currentStreamingId = null;
    },

    appendEntry(entry) {
      output.entries.push({ ...entry });
    },

    addToolCall(entry) {
      output.toolCalls.push({ ...entry, timestamp: Date.now() });
    },

    addPendingToolCall(entry) {
      output.pendingToolCalls.push({ ...entry, timestamp: Date.now() });
    },

    updateToolResult(name, result) {
      updateToolCall(output.toolCalls, name, result);
    },

    updatePendingToolResult(name, result) {
      updateToolCall(output.pendingToolCalls, name, result);
    },

    setInputHint(hint) {
      output.inputHint = hint;
    },

    setInputType(type, choices) {
      output.inputType = type;
      output.choices = choices ? [...choices] : null;
    },

    stagePendingDebug(info) {
      output.pendingDebug.push(copyPendingDebug(info));
    },

    updateDebug(debug) {
      output.debugSnapshots.push(copyDebugSnapshot(debug));
    },

    appendSentence(sentence) {
      output.sentences.push(copySentence(sentence));
    },

    emitSceneChange(scene, transition) {
      output.sceneChanges.push({
        scene: copyScene(scene),
        ...(transition !== undefined ? { transition } : {}),
      });
    },
  };

  return {
    emitter,
    getSnapshot: () => copyOutput(output),
    reset,
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
  tokenBreakdown: { ...snapshot.tokenBreakdown },
  activeSegmentIds: [...snapshot.activeSegmentIds],
});

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
