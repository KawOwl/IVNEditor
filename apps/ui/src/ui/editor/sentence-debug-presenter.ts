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

export function toSentenceDebugModel(sentence: Sentence): SentenceDebugModel {
  switch (sentence.kind) {
    case 'narration':
      return {
        borderClassName: 'border-zinc-700',
        header: formatHeader(sentence, 'narration'),
        body: {
          className: 'text-zinc-300 whitespace-pre-wrap',
          text: sentence.text,
        },
      };

    case 'dialogue':
      return {
        borderClassName: 'border-blue-700',
        header: formatHeader(sentence, 'dialogue'),
        headerBadge: sentence.truncated
          ? { className: 'text-red-400 ml-1', text: '[truncated]' }
          : undefined,
        speakerLine: {
          className: 'text-blue-300 text-[10px]',
          text: formatParticipationFrame(sentence.pf),
        },
        body: {
          className: 'text-zinc-200 whitespace-pre-wrap',
          text: sentence.text,
        },
      };

    case 'player_input':
      return {
        borderClassName: 'border-sky-700',
        header: formatHeader(sentence, 'player_input'),
        headerBadge: sentence.selectedIndex !== undefined
          ? { className: 'ml-1 text-amber-500', text: `[choice ${sentence.selectedIndex}]` }
          : undefined,
        body: {
          className: 'text-sky-200 whitespace-pre-wrap text-[11px]',
          text: sentence.text,
        },
      };

    case 'signal_input':
      return {
        borderClassName: 'border-amber-700',
        header: `${formatHeader(sentence, 'signal_input')} · ${sentence.choices.length} choice(s)`,
        body: {
          className: 'text-amber-300 text-[11px] whitespace-pre-wrap',
          text: sentence.hint,
        },
        footer: sentence.choices.length > 0
          ? {
              className: 'text-[10px] text-zinc-500',
              text: sentence.choices.map((choice, i) => `${i + 1}. ${choice}`).join(' / '),
            }
          : undefined,
      };

    case 'scene_change':
      return {
        borderClassName: 'border-emerald-700',
        header: formatHeader(sentence, 'scene_change'),
        headerBadge: sentence.transition
          ? { className: 'ml-1', text: `[${sentence.transition}]` }
          : undefined,
        body: {
          className: 'text-[10px] text-emerald-300',
          text: formatScene(sentence.scene),
        },
      };
  }
}

function formatHeader(
  sentence: Pick<Sentence, 'index' | 'turnNumber'>,
  kind: Sentence['kind'],
): string {
  return `#${sentence.index} · ${kind} · turn ${sentence.turnNumber}`;
}

function formatParticipationFrame(sentence: Extract<Sentence, { kind: 'dialogue' }>['pf']): string {
  const parts = [sentence.speaker];

  if (sentence.addressee) {
    parts.push(`-> ${sentence.addressee.join(', ')}`);
  }

  if (sentence.overhearers) {
    parts.push(`+${sentence.overhearers.join(',')}`);
  }

  if (sentence.eavesdroppers) {
    parts.push(`?${sentence.eavesdroppers.join(',')}`);
  }

  return parts.join(' ');
}

function formatScene(scene: SceneState): string {
  return `bg: ${scene.background ?? 'null'} · sprites: ${formatSprites(scene.sprites)}`;
}

function formatSprites(sprites: SceneState['sprites']): string {
  if (sprites.length === 0) return '—';
  return sprites.map((sprite) => `${sprite.id}:${sprite.emotion}`).join(', ');
}
