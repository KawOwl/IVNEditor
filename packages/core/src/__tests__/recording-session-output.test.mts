import { describe, expect, it } from 'bun:test';
import {
  batchId,
  createInputRequest,
  inputRequestId,
  stepId,
  turnId,
  type CoreEvent,
} from '#internal/game-session/core-events';
import { createLegacySessionEmitterProjection } from '#internal/game-session/legacy-session-emitter-projection';
import { createRecordingSessionEmitter } from '#internal/game-session/recording-emitter';
import type { RecordedSessionOutput } from '#internal/game-session/recording-emitter';
import { createRecordingSessionOutputSink } from '#internal/game-session/recording-session-output';
import type { PromptSnapshot, SceneState, Sentence, ToolCallEntry } from '#internal/types';

describe('createRecordingSessionOutputSink', () => {
  it('records session output directly from CoreEvents like the legacy projection', () => {
    const events = createRepresentativeCoreEvents();
    const direct = createRecordingSessionOutputSink();
    const legacyRecorder = createRecordingSessionEmitter();
    const legacyProjection = createLegacySessionEmitterProjection(legacyRecorder.emitter);

    for (const event of events) {
      direct.publish(event);
      legacyProjection.publish(event);
    }

    expect(normalizeOutput(direct.getSnapshot())).toEqual(
      normalizeOutput(legacyRecorder.getSnapshot()),
    );
  });
});

function createRepresentativeCoreEvents(): CoreEvent[] {
  const turn = turnId(1);
  const step = stepId(1, 1);
  const generateBatch = batchId('batch-generate-1')!;
  const receiveBatch = batchId('batch-receive-1')!;
  const requestId = inputRequestId(1);
  const scene: SceneState = { background: 'street', sprites: [] };
  const laterScene: SceneState = {
    background: 'cafe',
    sprites: [{ id: 'sakuya', emotion: 'smiling', position: 'center' }],
  };
  const snapshot = {
    turn: 1,
    stateVars: { current_scene: 'street' },
    memorySnapshot: { entries: [{ role: 'generate', content: 'hello' }], summaries: ['sum'] },
    currentScene: scene,
  };
  const promptSnapshot: PromptSnapshot = {
    systemPrompt: '你是互动小说 GM。',
    messages: [{ role: 'user', content: '继续' }],
    tokenBreakdown: {
      system: 8,
      state: 2,
      summaries: 1,
      recentHistory: 3,
      contextSegments: 4,
      total: 18,
      budget: 12000,
    },
    activeSegmentIds: ['rules'],
  };
  const narration: Exclude<Sentence, { kind: 'scene_change' }> = {
    kind: 'narration',
    text: '雨停了。',
    sceneRef: scene,
    turnNumber: 1,
    index: 0,
  };
  const sceneChange: Extract<Sentence, { kind: 'scene_change' }> = {
    kind: 'scene_change',
    scene: laterScene,
    transition: 'fade',
    turnNumber: 1,
    index: 1,
  };
  const inputRequest = createInputRequest('接下来呢？', ['进咖啡馆', '离开']);
  const signalInput: Extract<Sentence, { kind: 'signal_input' }> = {
    kind: 'signal_input',
    hint: '接下来呢？',
    choices: ['进咖啡馆', '离开'],
    sceneRef: laterScene,
    turnNumber: 1,
    index: 2,
  };
  const playerInput: Extract<Sentence, { kind: 'player_input' }> = {
    kind: 'player_input',
    text: '进咖啡馆',
    selectedIndex: 0,
    sceneRef: laterScene,
    turnNumber: 1,
    index: 3,
  };

  return [
    { type: 'session-started', snapshot },
    { type: 'generate-turn-started', turn: 1, turnId: turn },
    { type: 'context-assembled', turnId: turn, promptSnapshot },
    { type: 'assistant-message-started', turnId: turn },
    {
      type: 'llm-step-started',
      turnId: turn,
      stepId: step,
      batchId: generateBatch,
      isFollowup: false,
    },
    {
      type: 'assistant-reasoning-delta',
      turnId: turn,
      stepId: step,
      batchId: generateBatch,
      text: '观察天气',
    },
    {
      type: 'assistant-text-delta',
      turnId: turn,
      stepId: step,
      batchId: generateBatch,
      text: '<narration>雨停了。</narration>',
    },
    {
      type: 'tool-call-started',
      turnId: turn,
      stepId: step,
      batchId: generateBatch,
      toolName: 'change_scene',
      input: { background: 'cafe' },
    },
    {
      type: 'tool-call-finished',
      turnId: turn,
      stepId: step,
      batchId: generateBatch,
      toolName: 'change_scene',
      input: { background: 'cafe' },
      output: { success: true },
    },
    { type: 'assistant-message-finalized', turnId: turn, finishReason: 'tool-calls' },
    {
      type: 'narrative-batch-emitted',
      turnId: turn,
      batchId: generateBatch,
      sentences: [narration],
      scratches: [],
      degrades: [],
      sceneAfter: scene,
    },
    {
      type: 'narrative-segment-finalized',
      turnId: turn,
      stepId: step,
      batchId: generateBatch,
      reason: 'generate-complete',
      entry: {
        role: 'generate',
        content: '<narration>雨停了。</narration>',
        reasoning: '观察天气',
        finishReason: 'tool-calls',
      },
      sceneAfter: scene,
    },
    {
      type: 'scene-changed',
      turnId: turn,
      batchId: generateBatch,
      scene: laterScene,
      transition: 'fade',
      sentence: sceneChange,
    },
    {
      type: 'signal-input-recorded',
      turnId: turn,
      batchId: generateBatch,
      request: inputRequest,
      sentence: signalInput,
      sceneAfter: laterScene,
    },
    {
      type: 'waiting-input-started',
      turnId: turn,
      requestId,
      source: 'signal',
      causedByBatchId: generateBatch,
      request: inputRequest,
      snapshot: { ...snapshot, currentScene: laterScene },
    },
    {
      type: 'player-input-recorded',
      turnId: turn,
      requestId,
      batchId: receiveBatch,
      text: '进咖啡馆',
      payload: { inputType: 'choice', selectedIndex: 0 },
      sentence: playerInput,
      snapshot: { ...snapshot, currentScene: laterScene },
    },
    { type: 'memory-compaction-started', turnId: turn },
    {
      type: 'diagnostics-updated',
      diagnostics: {
        stateVars: { current_scene: 'cafe' },
        totalTurns: 1,
        memorySummaryCount: 1,
      },
    },
    {
      type: 'memory-compaction-completed',
      turnId: turn,
      snapshot: { ...snapshot, currentScene: laterScene },
    },
    {
      type: 'session-finished',
      reason: 'done',
      snapshot: { ...snapshot, currentScene: laterScene },
    },
  ];
}

function normalizeOutput(output: RecordedSessionOutput): RecordedSessionOutput {
  return {
    ...output,
    toolCalls: output.toolCalls.map(stripToolTimestamp),
    pendingToolCalls: output.pendingToolCalls.map(stripToolTimestamp),
  };
}

function stripToolTimestamp(entry: ToolCallEntry): ToolCallEntry {
  return { ...entry, timestamp: 0 };
}
