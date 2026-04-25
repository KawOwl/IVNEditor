import { describe, expect, it } from 'bun:test';
import { GameSession } from '#internal/game-session';
import type { RestoreConfig } from '#internal/game-session/types';
import { createCoreEventBus } from '#internal/game-session/core-events';
import { createRecordingCoreEventSink } from '#internal/game-session/recording-core-events';
import { createRecordingSessionEmitter } from '#internal/game-session/recording-emitter';
import { createSessionEmitterProjection } from '#internal/game-session/session-emitter-projection';
import type { MemoryConfig, PromptSegment, SceneState, StateSchema } from '#internal/types';

describe('GameSession CoreEvent projection', () => {
  it('projects restored and stopped lifecycle events through CoreEvents', async () => {
    const recording = createRecordingSessionEmitter();
    const coreRecorder = createRecordingCoreEventSink({ playthroughId: 'pt-core-events' });
    const session = new GameSession();
    const coreEventSink = createCoreEventBus([
      createSessionEmitterProjection(recording.emitter),
      coreRecorder,
    ]);
    const scene: SceneState = { background: 'hall', sprites: [] };

    await session.restore({
      ...baseRestoreConfig,
      coreEventSink,
      status: 'finished',
      turn: 2,
      stateVars: { current_scene: 'hall' },
      currentScene: scene,
    });
    session.stop();

    const output = recording.getSnapshot();
    expect(output.statuses).toEqual(['loading', 'finished', 'idle']);
    expect(output.sceneChanges).toEqual([{ scene }]);
    expect(output.debugSnapshots.at(-1)).toMatchObject({
      stateVars: { current_scene: 'hall' },
      totalTurns: 2,
    });
    expect(coreRecorder.getEvents().map((event) => event.type)).toEqual([
      'session-restored',
      'session-stopped',
    ]);
  });
});

const stateSchema: StateSchema = {
  variables: [
    {
      name: 'current_scene',
      type: 'string',
      initial: 'hall',
      description: '当前场景。',
    },
  ],
};

const memoryConfig: MemoryConfig = {
  provider: 'legacy',
  contextBudget: 4000,
  compressionThreshold: 10,
  recencyWindow: 2,
};

const systemSegment: PromptSegment = {
  id: 'rules',
  label: 'Rules',
  content: '你是互动小说 GM。',
  contentHash: 'rules-hash',
  type: 'content',
  sourceDoc: 'test',
  role: 'system',
  priority: 0,
  tokenCount: 12,
};

const baseRestoreConfig = {
  playthroughId: 'pt-core-events',
  userId: 'user-core-events',
  chapterId: 'chapter-core-events',
  segments: [systemSegment],
  stateSchema,
  memoryConfig,
  llmConfig: {
    provider: 'openai-compatible',
    baseURL: 'https://example.invalid/v1',
    apiKey: 'test-key',
    model: 'test-model',
    thinkingEnabled: false,
    reasoningEffort: null,
  },
  enabledTools: [],
  stateVars: {},
  turn: 0,
  memorySnapshot: null,
  status: 'idle',
  defaultScene: { background: null, sprites: [] },
} satisfies RestoreConfig;
