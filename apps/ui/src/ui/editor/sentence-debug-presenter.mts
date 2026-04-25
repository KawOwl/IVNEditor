import type { SceneState, Sentence } from '@ivn/core/types';

export interface SentenceDebugModel {
  borderClassName: string;
  header: string;
  headerBadge?: {
    className: string;
    text: string;
  };
  speakerLine?: {
    className: string;
    text: string;
  };
  body: {
    className: string;
    text: string;
  };
  footer?: {
    className: string;
    text: string;
  };
}

type NarrationSentence = Extract<Sentence, { kind: 'narration' }>;
type DialogueSentence = Extract<Sentence, { kind: 'dialogue' }>;
type PlayerInputSentence = Extract<Sentence, { kind: 'player_input' }>;
type SignalInputSentence = Extract<Sentence, { kind: 'signal_input' }>;
type SceneChangeSentence = Extract<Sentence, { kind: 'scene_change' }>;

export function toSentenceDebugModel(sentence: Sentence): SentenceDebugModel {
  switch (sentence.kind) {
    case 'narration':
      return toNarrationDebugModel(sentence);

    case 'dialogue':
      return toDialogueDebugModel(sentence);

    case 'player_input':
      return toPlayerInputDebugModel(sentence);

    case 'signal_input':
      return toSignalInputDebugModel(sentence);

    case 'scene_change':
      return toSceneChangeDebugModel(sentence);
  }
}

function toNarrationDebugModel({
  index,
  turnNumber,
  text,
}: NarrationSentence): SentenceDebugModel {
  return {
    borderClassName: 'border-zinc-700',
    header: formatHeader(index, turnNumber, 'narration'),
    body: {
      className: 'text-zinc-300 whitespace-pre-wrap',
      text,
    },
  };
}

function toDialogueDebugModel({
  index,
  turnNumber,
  text,
  truncated,
  pf,
}: DialogueSentence): SentenceDebugModel {
  return {
    borderClassName: 'border-blue-700',
    header: formatHeader(index, turnNumber, 'dialogue'),
    headerBadge: truncated
      ? { className: 'text-red-400 ml-1', text: '[truncated]' }
      : undefined,
    speakerLine: {
      className: 'text-blue-300 text-[10px]',
      text: formatParticipationFrame(pf),
    },
    body: {
      className: 'text-zinc-200 whitespace-pre-wrap',
      text,
    },
  };
}

function toPlayerInputDebugModel({
  index,
  turnNumber,
  text,
  selectedIndex,
}: PlayerInputSentence): SentenceDebugModel {
  return {
    borderClassName: 'border-sky-700',
    header: formatHeader(index, turnNumber, 'player_input'),
    headerBadge: selectedIndex !== undefined
      ? { className: 'ml-1 text-amber-500', text: `[choice ${selectedIndex}]` }
      : undefined,
    body: {
      className: 'text-sky-200 whitespace-pre-wrap text-[11px]',
      text,
    },
  };
}

function toSignalInputDebugModel({
  index,
  turnNumber,
  hint,
  choices,
}: SignalInputSentence): SentenceDebugModel {
  return {
    borderClassName: 'border-amber-700',
    header: `${formatHeader(index, turnNumber, 'signal_input')} · ${choices.length} choice(s)`,
    body: {
      className: 'text-amber-300 text-[11px] whitespace-pre-wrap',
      text: hint,
    },
    footer: choices.length > 0
      ? {
          className: 'text-[10px] text-zinc-500',
          text: formatChoices(choices),
        }
      : undefined,
  };
}

function toSceneChangeDebugModel({
  index,
  turnNumber,
  transition,
  scene,
}: SceneChangeSentence): SentenceDebugModel {
  return {
    borderClassName: 'border-emerald-700',
    header: formatHeader(index, turnNumber, 'scene_change'),
    headerBadge: transition
      ? { className: 'ml-1', text: `[${transition}]` }
      : undefined,
    body: {
      className: 'text-[10px] text-emerald-300',
      text: formatScene(scene),
    },
  };
}

function formatHeader(index: number, turnNumber: number, kind: Sentence['kind']): string {
  return `#${index} · ${kind} · turn ${turnNumber}`;
}

function formatParticipationFrame({
  speaker,
  addressee,
  overhearers,
  eavesdroppers,
}: DialogueSentence['pf']): string {
  return [
    speaker,
    addressee ? `-> ${addressee.join(', ')}` : undefined,
    overhearers ? `+${overhearers.join(',')}` : undefined,
    eavesdroppers ? `?${eavesdroppers.join(',')}` : undefined,
  ].filter((part): part is string => part !== undefined).join(' ');
}

function formatChoices(choices: string[]): string {
  return choices.map((choice, i) => `${i + 1}. ${choice}`).join(' / ');
}

function formatScene({ background, sprites }: SceneState): string {
  return `bg: ${background ?? 'null'} · sprites: ${formatSprites(sprites)}`;
}

function formatSprites(sprites: SceneState['sprites']): string {
  if (sprites.length === 0) return '—';
  return sprites.map(({ id, emotion }) => `${id}:${emotion}`).join(', ');
}
