import { describe, expect, it } from 'bun:test';
import { resolveRestorableInputState } from '#internal/session-restore-input-state';

describe('resolveRestorableInputState', () => {
  it('keeps a durable waiting choice state when the playthrough row is complete', () => {
    expect(resolveRestorableInputState({
      status: 'waiting-input',
      inputHint: 'row hint',
      inputType: 'choice',
      choices: ['row A'],
    }, [
      { kind: 'signal_input', content: 'entry hint', payload: { choices: ['entry A'] } },
    ])).toEqual({
      inputHint: 'row hint',
      inputType: 'choice',
      choices: ['row A'],
    });
  });

  it('recovers choices from the latest unconsumed signal_input entry', () => {
    expect(resolveRestorableInputState({
      status: 'waiting-input',
      inputHint: null,
      inputType: 'freetext',
      choices: null,
    }, [
      { kind: 'narrative', content: 'story', payload: null },
      { kind: 'signal_input', content: 'pick one', payload: { choices: ['A', 'B'] } },
    ])).toEqual({
      inputHint: 'pick one',
      inputType: 'choice',
      choices: ['A', 'B'],
    });
  });

  it('does not reuse a consumed signal_input from an older turn', () => {
    expect(resolveRestorableInputState({
      status: 'waiting-input',
      inputHint: null,
      inputType: 'freetext',
      choices: null,
    }, [
      { kind: 'signal_input', content: 'old pick', payload: { choices: ['old'] } },
      { kind: 'player_input', content: 'old', payload: { inputType: 'choice', selectedIndex: 0 } },
      { kind: 'narrative', content: 'new story', payload: null },
    ])).toEqual({
      inputHint: null,
      inputType: 'freetext',
      choices: null,
    });
  });

  it('does not infer choices for non-waiting sessions', () => {
    expect(resolveRestorableInputState({
      status: 'generating',
      inputHint: null,
      inputType: 'freetext',
      choices: null,
    }, [
      { kind: 'signal_input', content: 'pick one', payload: { choices: ['A'] } },
    ])).toEqual({
      inputHint: null,
      inputType: 'freetext',
      choices: null,
    });
  });
});
