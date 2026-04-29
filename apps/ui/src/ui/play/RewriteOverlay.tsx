/**
 * RewriteOverlay — narrative-rewrite 阶段的 UI 遮罩
 *
 * 设计（2026-04-26 修订）：
 *   - 只**遮住对话框区域**（底部 dialog box，inset-x-0 bottom-0），
 *     不遮背景 / 立绘 —— 玩家仍能看到画面，只是知道台词正在调整
 *   - 文案"正在整理格式"——比"AI 审稿中"更轻量、less anthropomorphic
 *   - 旋转齿轮 ⚙ + fade-in / fade-out + 顶边 shimmer 跟 DialogBox 共用
 */

import { useEffect, useState } from 'react';

import { useGameStore } from '#internal/stores/game-store';

const REWRITING_LABEL = '正在整理格式';
const REWRITING_HINT = '稍后会重新呈现这一段';
const FADE_OUT_MS = 240;

export function RewriteOverlay(): React.ReactElement | null {
  const isRewriting = useGameStore((s) => s.isRewriting);
  const [visible, setVisible] = useState(false);
  const [fadingOut, setFadingOut] = useState(false);

  useEffect(() => {
    if (isRewriting) {
      setFadingOut(false);
      setVisible(true);
      return;
    }
    if (!visible) return;
    setFadingOut(true);
    const timer = window.setTimeout(() => {
      setVisible(false);
      setFadingOut(false);
    }, FADE_OUT_MS);
    return () => window.clearTimeout(timer);
  }, [isRewriting, visible]);

  if (!visible) return null;

  return (
    <div
      className={
        // 只盖对话框：贴底 + 跟 DialogBox 同样的 min-h-[8rem] 区域
        // z-30 高于 DialogBox 的 z-20，低于潜在 modal 层
        'absolute inset-x-0 bottom-0 z-30 min-h-[8rem] pointer-events-auto ' +
        'flex items-center justify-center ' +
        'bg-zinc-950/85 backdrop-blur-sm border-t border-zinc-700/60 ' +
        'transition-opacity duration-200 ease-out dialog-working-breathe ' +
        (fadingOut ? 'opacity-0' : 'opacity-100')
      }
      role="status"
      aria-live="polite"
      aria-label={REWRITING_LABEL}
    >
      {/* 顶边 shimmer：跟 DialogBox.generating 共用同一条动画类，让玩家
       *  在 generating → rewriting 切换之间感到画面持续在"动"，不会有
       *  动效断档突然变静止的错觉。*/}
      <div className="dialog-working-bar" aria-hidden="true" />
      <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-2xl bg-zinc-900/90 ring-1 ring-zinc-700 shadow-lg">
        <span
          className="inline-block text-zinc-300 text-base"
          aria-hidden="true"
          style={{ animation: 'spin 2.4s linear infinite' }}
        >
          ⚙
        </span>
        <div className="flex flex-col leading-tight">
          <span className="text-xs font-medium text-zinc-200">{REWRITING_LABEL}</span>
          <span className="text-[10px] text-zinc-400 mt-0.5">{REWRITING_HINT}</span>
        </div>
      </div>
    </div>
  );
}
