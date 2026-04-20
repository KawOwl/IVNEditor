/**
 * SceneBackground — VN 背景层
 *
 * 渲染全屏背景 + 切换过渡动效（M1 Step 1.5）。
 *
 * 过渡模型：crossfade
 *   - 背景 id 变化时，保留前一个作为"离场层"淡出，新的作为"入场层"淡入
 *   - duration 来自 transition prop（默认 300ms，'cut' = 0，'dissolve' = 500ms）
 *
 * 资产 URL 兜底（Step 1.1/1.9）：
 *   - backgrounds[] 里有匹配 id 且 assetUrl 非空 → <div bg-cover>
 *   - 否则 → 纯色块 + `[background: <label>]` 占位文字
 *   - backgroundId === null → 纯黑（幕前/幕间）
 */

import { useEffect, useRef, useState } from 'react';
import type { BackgroundAsset } from '../../../core/types';

export type SceneTransition = 'fade' | 'cut' | 'dissolve';

const TRANSITION_MS: Record<SceneTransition, number> = {
  fade: 300,
  cut: 0,
  dissolve: 500,
};

export interface SceneBackgroundProps {
  /** 当前背景 id，来自 SceneState.background（null = 无背景） */
  backgroundId: string | null;
  /** 剧本定义的背景资产索引（M2 从 manifest.backgrounds 传入） */
  backgrounds: BackgroundAsset[];
  /** 切换过渡（来自最近一次 scene_change Sentence 的 transition 字段；默认 fade） */
  transition?: SceneTransition;
}

export function SceneBackground({ backgroundId, backgrounds, transition = 'fade' }: SceneBackgroundProps) {
  // 上一帧的 backgroundId，用来做 crossfade 的"离场层"
  const [prev, setPrev] = useState<string | null>(null);
  const prevRef = useRef<string | null>(backgroundId);
  const duration = TRANSITION_MS[transition];

  useEffect(() => {
    if (prevRef.current !== backgroundId) {
      const lastId = prevRef.current;
      prevRef.current = backgroundId;
      if (duration === 0) {
        // cut：直接替换，不保留 prev
        setPrev(null);
        return;
      }
      setPrev(lastId);
      const t = setTimeout(() => setPrev(null), duration + 50);
      return () => clearTimeout(t);
    }
  }, [backgroundId, duration]);

  return (
    <>
      {prev !== null && (
        <Layer
          backgroundId={prev}
          backgrounds={backgrounds}
          phase="out"
          duration={duration}
          key={`out-${prev}`}
        />
      )}
      <Layer
        backgroundId={backgroundId}
        backgrounds={backgrounds}
        phase="in"
        duration={duration}
        key={`in-${backgroundId ?? 'null'}`}
      />
    </>
  );
}

interface LayerProps {
  backgroundId: string | null;
  backgrounds: BackgroundAsset[];
  phase: 'in' | 'out';
  duration: number;
}

function Layer({ backgroundId, backgrounds, phase, duration }: LayerProps) {
  // 入场层：opacity 0 → 1；离场层：opacity 1 → 0
  const [opacity, setOpacity] = useState(phase === 'in' ? 0 : 1);

  useEffect(() => {
    if (duration === 0) {
      setOpacity(phase === 'in' ? 1 : 0);
      return;
    }
    // 强制下一帧再改，确保 transition 生效
    const raf = requestAnimationFrame(() => setOpacity(phase === 'in' ? 1 : 0));
    return () => cancelAnimationFrame(raf);
  }, [phase, duration]);

  const style = {
    opacity,
    transition: duration === 0 ? 'none' : `opacity ${duration}ms ease-in-out`,
  } as const;

  if (backgroundId === null) {
    return <div className="absolute inset-0 bg-black" style={style} aria-label="scene-background-empty" />;
  }

  const asset = backgrounds.find((b) => b.id === backgroundId);
  const assetUrl = asset?.assetUrl;

  if (assetUrl) {
    return (
      <div
        className="absolute inset-0 bg-cover bg-center"
        style={{ ...style, backgroundImage: `url(${JSON.stringify(assetUrl)})` }}
        aria-label={`scene-background-${backgroundId}`}
      />
    );
  }

  // 占位
  const label = asset?.label ?? backgroundId;
  return (
    <div
      className="absolute inset-0 flex items-center justify-center bg-zinc-800"
      style={style}
      aria-label={`scene-background-placeholder-${backgroundId}`}
    >
      <div className="rounded border border-zinc-600 bg-zinc-900/60 px-4 py-2 font-mono text-sm text-zinc-400">
        [background: {label}]
      </div>
    </div>
  );
}
