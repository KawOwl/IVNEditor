/**
 * RewriteOverlay — narrative-rewrite 阶段的 UI 遮罩（PR3：选项 C 完整版）
 *
 * 设计：
 *   - 玩家在 raw 流式阶段已经看到了 LLM 主路径输出的 sentence
 *   - 主路径完成 → 触发 rewrite → rewrite 期间在 stage 上**半透明覆盖**：玩家
 *     能透过看到 raw 内容（保留现有 stream 视觉感），但被一层模糊 + "审稿中"
 *     徽标提示告知"内容尚未定稿"
 *   - rewrite 完成（applied）→ narrative-turn-reset 清掉 raw + 重新 emit
 *     rewrite 的 sentence；overlay 自然 unmount
 *   - rewrite fallback → overlay 同样 unmount，玩家继续看到 raw
 *
 * fade-in / fade-out 用 CSS transition 配合短暂延迟 unmount 实现，避免遮罩
 * 闪烁/突变。
 */

import { useEffect, useState } from 'react';

import { useGameStore } from '#internal/stores/game-store';

const REWRITING_LABEL = 'AI 正在审稿…';
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
    // rewrite 结束 → 触发 fade-out 后再 unmount
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
        'absolute inset-0 z-40 pointer-events-auto flex flex-col items-center justify-end pb-8 gap-3 ' +
        'bg-black/40 backdrop-blur-md transition-opacity duration-200 ease-out ' +
        (fadingOut ? 'opacity-0' : 'opacity-100')
      }
      role="status"
      aria-live="polite"
      aria-label={REWRITING_LABEL}
    >
      <div className="flex items-center gap-2.5 px-4 py-2 rounded-full bg-zinc-900/90 ring-1 ring-zinc-700 shadow-lg">
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse [animation-delay:200ms]" />
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse [animation-delay:400ms]" />
        </span>
        <span className="text-xs font-medium text-zinc-200">{REWRITING_LABEL}</span>
      </div>
      <span className="text-[10px] text-zinc-500">内容尚未定稿，稍候自动更新</span>
    </div>
  );
}
