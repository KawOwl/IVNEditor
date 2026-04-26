/**
 * RewriteOverlay — narrative-rewrite 阶段的 UI 遮罩
 *
 * PR2（最简版）：rewrite 期间整屏 loading 全覆盖，玩家看不到 raw stream。
 * PR3：换成半透明遮罩 + 模糊滤镜，让玩家能隐约看到 raw 但知道正在审稿。
 *
 * 接 game-store.isRewriting：rewrite-attempted → true，rewrite-completed → false。
 */

import { useGameStore } from '#internal/stores/game-store';

const REWRITING_LABEL = 'AI 正在审稿…';

export function RewriteOverlay(): React.ReactElement | null {
  const isRewriting = useGameStore((s) => s.isRewriting);
  if (!isRewriting) return null;

  return (
    <div
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/85 backdrop-blur-sm pointer-events-auto"
      role="status"
      aria-live="polite"
      aria-label={REWRITING_LABEL}
    >
      <div className="flex flex-col items-center gap-4">
        <div className="flex items-center gap-2.5">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse [animation-delay:200ms]" />
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse [animation-delay:400ms]" />
        </div>
        <span className="text-sm font-medium text-zinc-300">{REWRITING_LABEL}</span>
      </div>
    </div>
  );
}
