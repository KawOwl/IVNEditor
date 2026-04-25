import { describe, expect, it } from 'bun:test';
import { GameSession } from '#internal/game-session';
import type { RestoreConfig } from '#internal/game-session/types';
import { createCoreEventBus } from '#internal/game-session/core-events';
import { createRecordingCoreEventSink } from '#internal/game-session/recording-core-events';
import { createRecordingSessionOutputSink } from '#internal/game-session/recording-session-output';
import { buildParserManifest } from '#internal/narrative-parser-v2';
import type { MemoryConfig, PromptSegment, SceneState, StateSchema } from '#internal/types';

describe('GameSession CoreEvent projection', () => {
  it('projects restored and stopped lifecycle events through CoreEvents', async () => {
    const recording = createRecordingSessionOutputSink();
    const coreRecorder = createRecordingCoreEventSink({ playthroughId: 'pt-core-events' });
    const session = new GameSession();
    const coreEventSink = createCoreEventBus([
      recording,
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

  it('reports an error instead of running legacy-readable v1 sessions', async () => {
    const coreRecorder = createRecordingCoreEventSink({ playthroughId: 'pt-v1-readonly' });
    const session = new GameSession();

    await session.restore({
      ...baseRestoreConfig,
      playthroughId: 'pt-v1-readonly',
      coreEventSink: coreRecorder,
      protocolVersion: 'v1-tool-call',
      parserManifest: undefined,
    });

    expect(coreRecorder.getEvents()).toEqual([
      {
        type: 'session-error',
        phase: 'restore',
        message: '[protocol] v1-tool-call is legacy-readable only and cannot be used to run a session',
      },
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
  protocolVersion: 'v2-declarative-visual',
  parserManifest: buildParserManifest({}),
  stateVars: {},
  turn: 0,
  memorySnapshot: null,
  status: 'idle',
  defaultScene: { background: null, sprites: [] },
} satisfies RestoreConfig;
