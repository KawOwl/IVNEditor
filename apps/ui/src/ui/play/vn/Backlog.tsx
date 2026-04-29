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

import { useRef, useState } from 'react';
import { useGameStore } from '@/stores/game-store';
import type { Sentence, CharacterAsset } from '@ivn/core/types';
import { resolveSpeakerName } from '#internal/ui/play/vn/speaker-name';

export interface BacklogProps {
  characters: CharacterAsset[];
}

export function Backlog({ characters }: BacklogProps) {
  const [open, setOpen] = useState(false);
  const parsedSentences = useGameStore((s) => s.parsedSentences);
  // 滚动容器 ref —— 按钮在 DOM 里是 drawer 的兄弟节点（不是孩子），所以光标
  // 停在按钮上滚轮时，wheel 事件找不到 overflow-y-auto 祖先，会直接"掉空"。
  // 给按钮挂 onWheel 把 deltaY 手动转发给这个 ref 补上死区。
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <>
      {/* 悬浮按钮 */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        onWheel={(e) => {
          // open 时按钮压在 drawer 顶端，滚轮 deltaY 转发给滚动容器。
          // 不需要 stopPropagation / preventDefault：按钮的 DOM 祖先链里
          // 没有 overflow-auto，冒泡本来就不会 hit 其它 scroller。
          if (open && scrollRef.current) {
            scrollRef.current.scrollTop += e.deltaY;
          }
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
        <div ref={scrollRef} className="h-full overflow-y-auto px-4 pt-14 pb-4">
          {parsedSentences.length === 0 ? (
            <div className="text-center text-sm text-zinc-500 mt-8">还没有内容</div>
          ) : (
            <ol className="space-y-3">
              {parsedSentences.map((s, i) => (
                <li key={i}>
                  <BacklogEntry
                    sentence={s}
                    characters={characters}
                    // 如果下一条是玩家输入，把它的 selectedIndex 传进来高亮选项
                    nextSelectedIndex={
                      s.kind === 'signal_input' &&
                      parsedSentences[i + 1]?.kind === 'player_input'
                        ? (parsedSentences[i + 1] as { selectedIndex?: number }).selectedIndex
                        : undefined
                    }
                  />
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
  nextSelectedIndex,
}: {
  sentence: Sentence;
  characters: CharacterAsset[];
  /** 若此 Sentence 是 signal_input，且紧随其后是 player_input，则传对应 selectedIndex 来高亮 */
  nextSelectedIndex?: number;
}) {
  if (sentence.kind === 'scene_change') {
    const bg = sentence.scene.background ?? '（无背景）';
    const sprites = sentence.scene.sprites.map((sp) => `${resolveSpeakerName(sp.id, characters)}:${sp.emotion}`).join(', ') || '（无立绘）';
    return (
      <div className="rounded border border-zinc-800 bg-zinc-900/50 px-3 py-2 font-mono text-[11px] text-zinc-500">
        〔场景 → {bg} / {sprites}〕
      </div>
    );
  }

  if (sentence.kind === 'signal_input') {
    // 📍 signal_input_needed 一次调用（migration 0010 / Step 4）：GM 问 + 选项清单
    return (
      <div className="rounded border border-amber-900/30 bg-amber-950/20 px-3 py-2">
        <div className="text-[10px] font-semibold text-amber-400/70 mb-1">💬 询问</div>
        <div className="text-sm leading-relaxed text-amber-100/80 whitespace-pre-wrap mb-1.5">
          {sentence.hint}
        </div>
        {sentence.choices.length > 0 && (
          <ol className="text-xs space-y-0.5 mt-1">
            {sentence.choices.map((c, i) => {
              const picked = i === nextSelectedIndex;
              return (
                <li
                  key={i}
                  className={`pl-4 ${picked ? 'text-sky-300 font-medium' : 'text-zinc-500'}`}
                >
                  {picked ? '→ ' : `${i + 1}. `}
                  {c}
                </li>
              );
            })}
          </ol>
        )}
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
    // 如果 player_input 有 selectedIndex，说明是从 signal_input 的 choices 里选的；
    // 前面的 signal_input entry 已经高亮了对应选项，这里仍然完整显示玩家文本
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
      </div>
    </div>
  );
}

