import { describe, expect, it } from 'bun:test';
import { runMemoryEvaluationSuite } from '#internal/evaluation/memory-harness';
import { batchId, turnId } from '#internal/game-session/core-events';
import { createRecordingSessionEmitter, type RecordedSessionOutput } from '#internal/game-session/recording-emitter';
import { createSessionEmitterProjection } from '#internal/game-session/session-emitter-projection';
import type { MemoryConfig, PromptSegment, Sentence, StateSchema, ToolCallEntry } from '#internal/types';

describe('createSessionEmitterProjection', () => {
  it('replays CoreEvents into the same RecordingSessionEmitter output as the legacy emitter', async () => {
    const report = await runMemoryEvaluationSuite({
      scenario: {
        id: 'projection-silver-key',
        segments: [systemSegment],
        stateSchema,
        initialPrompt: '开场。',
        enabledTools: [],
        tokenBudget: 12000,
      },
      variants: [
        { id: 'legacy', memoryConfig: { ...baseMemoryConfig, provider: 'legacy' } },
        {
          id: 'llm-summary',
          memoryConfig: { ...baseMemoryConfig, provider: 'llm-summarizer' },
        },
      ],
      compression: {
        responses: ['Luna 把银钥匙交给玩家；玩家选择收下，并准备继续调查。'],
      },
      script: [
        {
          generate: {
            text: ['Luna 把一枚银钥匙', '放到你掌心。'],
            reasoning: ['需要给玩家选择。'],
            toolCalls: [
              {
                name: 'signal_input_needed',
                args: {
                  prompt_hint: '要收下银钥匙吗？',
                  choices: ['收下银钥匙', '先问清来历'],
                },
              },
            ],
          },
          input: '收下银钥匙',
        },
        {
          generate: {
            text: '你记得银钥匙属于图书馆深处的禁门。',
            toolCalls: [
              {
                name: 'signal_input_needed',
                args: {
                  prompt_hint: '下一步？',
                  choices: ['去禁门', '回大厅'],
                },
              },
            ],
          },
        },
      ],
    });

    for (const run of report.runs) {
      const projectionRecording = createRecordingSessionEmitter();
      const projection = createSessionEmitterProjection(projectionRecording.emitter);

      for (const event of run.coreEvents) {
        projection.publish(event);
      }

      expect(normalizeOutput(projectionRecording.getSnapshot())).toEqual(
        normalizeOutput(run.recording),
      );
    }
  });

  it('projects scene changes before the scene-change sentence', () => {
    const recording = createRecordingSessionEmitter();
    const projection = createSessionEmitterProjection(recording.emitter);
    const scene = { background: 'library', sprites: [] };
    const sentence: Sentence = {
      kind: 'scene_change',
      scene,
      transition: 'fade',
      turnNumber: 1,
      index: 0,
    };

    projection.publish({
      type: 'scene-changed',
      turnId: turnId(1),
      batchId: batchId('batch-1'),
      scene,
      transition: 'fade',
      sentence,
    });

    expect(recording.getSnapshot().sceneChanges).toEqual([
      { scene, transition: 'fade' },
    ]);
    expect(recording.getSnapshot().sentences).toEqual([sentence]);
  });

  it('projects finished restore snapshots to finished status', () => {
    const recording = createRecordingSessionEmitter();
    const projection = createSessionEmitterProjection(recording.emitter);

    projection.publish({
      type: 'session-restored',
      restoredFrom: 'finished',
      snapshot: {
        turn: 3,
        stateVars: {},
        memorySnapshot: {},
        currentScene: { background: 'library', sprites: [] },
      },
    });

    expect(recording.getSnapshot().statuses).toEqual(['loading', 'finished']);
  });
});

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

const baseMemoryConfig: MemoryConfig = {
  contextBudget: 4000,
  compressionThreshold: 1,
  recencyWindow: 1,
  compressionHints: '保留银钥匙和玩家选择。',
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
