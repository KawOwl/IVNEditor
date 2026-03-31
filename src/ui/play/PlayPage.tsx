/**
 * PlayPage — 全屏对话页面
 *
 * 从首页点击卡片进入。包装 PlayPanel 并添加全屏布局 + 导航栏。
 */

import { useCallback } from 'react';
import { useAppStore } from '../../stores/app-store';
import { useGameStore } from '../../stores/game-store';
import { PlayPanel } from './PlayPanel';
import type { ScriptManifest } from '../../core/types';

export interface PlayPageProps {
  manifest: ScriptManifest;
}

export function PlayPage({ manifest }: PlayPageProps) {
  const goHome = useAppStore((s) => s.goHome);

  const handleBack = useCallback(() => {
    useGameStore.getState().reset();
    goHome();
  }, [goHome]);

  return (
    <div className="h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Header */}
      <header className="flex-none px-6 py-3 border-b border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={handleBack}
            className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            ← 返回
          </button>
          <h1 className="text-sm font-medium text-zinc-300">
            {manifest.label}
          </h1>
        </div>
      </header>

      {/* Play panel fills remaining space */}
      <div className="flex-1 min-h-0">
        <PlayPanel manifest={manifest} showDebug />
      </div>
    </div>
  );
}
