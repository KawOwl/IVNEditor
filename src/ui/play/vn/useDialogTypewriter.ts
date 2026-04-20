/**
 * useDialogTypewriter — Sentence 级打字机（M1 Step 1.4）
 *
 * 和老 `useTypewriter`（NarrativeView 那个）的差别：
 *   - 老的是"追赶持续增长的 buffer"（streaming text-chunk 模型）
 *   - 这个是"从 0 匀速打到 text 末尾"（Sentence 已经成品了才送来）
 *
 * API：
 *   const { displayed, done, skipToEnd } = useDialogTypewriter(text, cps);
 *
 *   - displayed：当前要显示的子串
 *   - done：true = 已经打完整段
 *   - skipToEnd：一下跳到末尾（click 时用）
 *
 * cps <= 0 视为"不做动画，立刻全显"。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface TypewriterState {
  displayed: string;
  done: boolean;
  skipToEnd: () => void;
}

export function useDialogTypewriter(fullText: string, cps: number): TypewriterState {
  const [cursor, setCursor] = useState(() => (cps <= 0 ? fullText.length : 0));
  const rafRef = useRef<number | null>(null);

  // 文本换了 → 游标归零（或在 cps<=0 时立即到达末尾）
  useEffect(() => {
    setCursor(cps <= 0 ? fullText.length : 0);
  }, [fullText, cps]);

  // 驱动循环：基于时间，不依赖 cursor 做 dep，避免每帧 setInterval 重启
  useEffect(() => {
    if (cps <= 0 || fullText.length === 0) return;

    let startTime: number | null = null;
    const loop = (t: number) => {
      if (startTime === null) startTime = t;
      const elapsed = t - startTime;
      const target = Math.min(fullText.length, Math.floor((elapsed / 1000) * cps));
      setCursor((prev) => {
        // 如果调用方 skipToEnd 已经把 cursor 设到 length，别被 RAF 拉回来
        if (prev >= fullText.length) return prev;
        return target > prev ? target : prev;
      });
      if (target < fullText.length) {
        rafRef.current = requestAnimationFrame(loop);
      }
    };
    rafRef.current = requestAnimationFrame(loop);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [fullText, cps]);

  const skipToEnd = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setCursor(fullText.length);
  }, [fullText.length]);

  return {
    displayed: fullText.slice(0, cursor),
    done: cursor >= fullText.length,
    skipToEnd,
  };
}
