import { describe, expect, it } from 'bun:test';
import { createRecordingSessionEmitter } from '#internal/game-session/recording-emitter';
import type { Sentence } from '#internal/types';

describe('createRecordingSessionEmitter', () => {
  it('records GameSession output without a UI transport', () => {
    const recorder = createRecordingSessionEmitter();
    const streamId = recorder.emitter.beginStreamingEntry();
    const sentence: Sentence = {
      kind: 'narration',
      text: '雨停了。',
      sceneRef: { background: 'street', sprites: [] },
      turnNumber: 1,
      index: 0,
    };

    recorder.emitter.setInputHint('下一步？');
    recorder.emitter.setInputType('choice', ['继续调查', '回家']);
    recorder.emitter.setStatus('waiting-input');
    recorder.emitter.appendToStreamingEntry('雨停');
    recorder.emitter.appendToStreamingEntry('了。');
    recorder.emitter.appendReasoningToStreamingEntry('观察天气');
    recorder.emitter.finalizeStreamingEntry();
    recorder.emitter.appendSentence(sentence);
    recorder.emitter.emitSceneChange({ background: 'street', sprites: [] }, 'fade');

    const output = recorder.getSnapshot();

    expect(streamId).toBe('recording-stream-1');
    expect(output.status).toBe('waiting-input');
    expect(output.inputRequests).toEqual([
      { hint: '下一步？', inputType: 'choice', choices: ['继续调查', '回家'] },
    ]);
    expect(output.streamingEntries).toEqual([
      {
        id: 'recording-stream-1',
        text: '雨停了。',
        reasoning: '观察天气',
        finalized: true,
      },
    ]);
    expect(output.sentences).toEqual([sentence]);
    expect(output.sceneChanges).toEqual([
      { scene: { background: 'street', sprites: [] }, transition: 'fade' },
    ]);
  });

  it('returns snapshots that are isolated from later recorder changes', () => {
    const recorder = createRecordingSessionEmitter();

    recorder.emitter.setStatus('generating');
    const beforeReset = recorder.getSnapshot();
    recorder.reset();
    recorder.emitter.setStatus('idle');

    expect(beforeReset.statuses).toEqual(['generating']);
    expect(recorder.getSnapshot().statuses).toEqual(['idle']);
  });
});
