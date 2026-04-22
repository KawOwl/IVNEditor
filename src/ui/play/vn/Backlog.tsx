/**
 * Backlog — VN 回看面板（M1 Step 1.6）
 *
 * 右侧可折叠 drawer，列出当前 playthrough 所有 Sentence。
 *
 * MVP 范围：**只读**
 *   - 不支持点击条目回跳 visibleSentenceIndex（改游标会让未来 Sentence 的
 *     index 语义错乱，留给后续 milestone）
 *   - 不支持搜索 / 过滤
 *   - 不区分不同 turnNumber（scroll 上去就能看完）
 *
 * 触发：右上角悬浮按钮「回看」
 */

import { useState } from 'react';
import { useGameStore } from '../../../stores/game-store';
import type { Sentence, CharacterAsset } from '../../../core/types';

export interface BacklogProps {
  characters: CharacterAsset[];
}

export function Backlog({ characters }: BacklogProps) {
  const [open, setOpen] = useState(false);
  const parsedSentences = useGameStore((s) => s.parsedSentences);

  return (
    <>
      {/* 悬浮按钮 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="absolute right-3 top-3 z-40 rounded bg-zinc-900/70 px-3 py-1.5 text-xs text-zinc-300 backdrop-blur-sm hover:bg-zinc-800 transition-colors"
        aria-label="backlog-toggle"
      >
        {open ? '关闭' : '回看'}
      </button>

      {/* Drawer */}
      <div
        className={`absolute right-0 top-0 z-30 h-full w-[380px] max-w-[80vw] border-l border-zinc-700 bg-zinc-950/95 backdrop-blur-sm overflow-hidden transition-transform duration-300 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
        onClick={(e) => e.stopPropagation()}
        aria-label="backlog-drawer"
      >
        <div className="h-full overflow-y-auto px-4 pt-14 pb-4">
          {parsedSentences.length === 0 ? (
            <div className="text-center text-sm text-zinc-500 mt-8">还没有内容</div>
          ) : (
            <ol className="space-y-3">
              {parsedSentences.map((s, i) => (
                <li key={i}>
                  <BacklogEntry sentence={s} characters={characters} />
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </>
  );
}

function BacklogEntry({
  sentence,
  characters,
}: {
  sentence: Sentence;
  characters: CharacterAsset[];
}) {
  if (sentence.kind === 'scene_change') {
    const bg = sentence.scene.background ?? '（无背景）';
    const sprites = sentence.scene.sprites.map((sp) => `${resolveName(sp.id, characters)}:${sp.emotion}`).join(', ') || '（无立绘）';
    return (
      <div className="rounded border border-zinc-800 bg-zinc-900/50 px-3 py-2 font-mono text-[11px] text-zinc-500">
        〔场景 → {bg} / {sprites}〕
      </div>
    );
  }

  if (sentence.kind === 'narration') {
    return (
      <div className="text-sm leading-relaxed text-zinc-400 whitespace-pre-wrap">
        {sentence.text}
      </div>
    );
  }

  if (sentence.kind === 'player_input') {
    return (
      <div className="border-l-2 border-sky-400/40 pl-2">
        <div className="text-xs font-semibold text-sky-300/90">我</div>
        <div className="text-sm leading-relaxed text-sky-100/80 whitespace-pre-wrap">
          {sentence.text}
        </div>
      </div>
    );
  }

  // dialogue
  const speakerName = resolveSpeakerName(sentence.pf.speaker, characters);
  return (
    <div>
      <div className="text-xs font-semibold text-amber-300/90">{speakerName}</div>
      <div className="text-sm leading-relaxed text-zinc-200 whitespace-pre-wrap">
        {sentence.text}
        {sentence.truncated && (
          <span className="ml-1 text-zinc-500 text-xs">…（截断）</span>
        )}
      </div>
    </div>
  );
}

function resolveSpeakerName(speakerId: string, characters: CharacterAsset[]): string {
  if (speakerId === 'player') return '我';
  if (speakerId === 'unknown') return '？';
  return resolveName(speakerId, characters);
}

function resolveName(id: string, characters: CharacterAsset[]): string {
  return characters.find((c) => c.id === id)?.displayName ?? id;
}
