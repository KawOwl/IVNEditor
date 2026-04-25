import type { NarrativeEntryRow, PlaythroughDetail } from '#internal/services/playthrough-service';

export interface RestorableInputState {
  readonly inputHint: string | null;
  readonly inputType: string;
  readonly choices: string[] | null;
}

type InputStateSnapshot = Pick<PlaythroughDetail, 'status' | 'inputHint' | 'inputType' | 'choices'>;
type RestoreInputEntry = Pick<NarrativeEntryRow, 'kind' | 'content' | 'payload'>;

export function resolveRestorableInputState(
  snapshot: InputStateSnapshot,
  recentEntries: readonly RestoreInputEntry[],
): RestorableInputState {
  const current = {
    inputHint: snapshot.inputHint,
    inputType: snapshot.inputType,
    choices: copyChoices(snapshot.choices),
  };
  if (snapshot.status !== 'waiting-input' || hasChoiceState(current)) return current;

  const signal = findLatestUnconsumedSignalInput(recentEntries);
  if (!signal) return current;

  const choices = readChoices(signal.payload);
  if (choices.length === 0) return current;

  return {
    inputHint: signal.content || current.inputHint,
    inputType: 'choice',
    choices,
  };
}

function hasChoiceState(state: RestorableInputState): boolean {
  return state.inputType === 'choice' && !!state.choices && state.choices.length > 0;
}

function findLatestUnconsumedSignalInput(
  entries: readonly RestoreInputEntry[],
): RestoreInputEntry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!entry) continue;
    if (entry.kind === 'player_input') return null;
    if (entry.kind === 'signal_input') return entry;
  }
  return null;
}

function readChoices(payload: Record<string, unknown> | null): string[] {
  const value = payload?.choices;
  return Array.isArray(value)
    ? value.filter((choice): choice is string => typeof choice === 'string')
    : [];
}

function copyChoices(choices: readonly string[] | null): string[] | null {
  return choices ? [...choices] : null;
}
