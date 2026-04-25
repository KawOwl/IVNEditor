import type { Sentence } from '@ivn/core/types';

export function getLastDisplayableSentenceIndex(sentences: readonly Sentence[]): number {
  for (let i = sentences.length - 1; i >= 0; i--) {
    const kind = sentences[i]?.kind;
    if (kind !== 'scene_change' && kind !== 'signal_input') return i;
  }
  return -1;
}

export function isAtReadableEnd(
  sentences: readonly Sentence[],
  visibleSentenceIndex: number | null,
): boolean {
  const lastDisplayableIdx = getLastDisplayableSentenceIndex(sentences);
  if (lastDisplayableIdx < 0) return true;
  return visibleSentenceIndex !== null && visibleSentenceIndex >= lastDisplayableIdx;
}
