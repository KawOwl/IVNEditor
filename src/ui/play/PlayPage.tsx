/**
 * PlayPage — 全屏对话页面
 *
 * 从首页点击卡片进入。包装 PlayPanel 并添加全屏布局 + 导航栏。
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useAppStore } from '../../stores/app-store';
import { useGameStore } from '../../stores/game-store';
import { PlayPanel } from './PlayPanel';
import { getTypewriterSpeed, setTypewriterSpeed } from '../NarrativeView';
import type { ScriptManifest } from '../../core/types';
import { cn } from '../../lib/utils';

export interface PlayPageProps {
  manifest: ScriptManifest;
  scriptId: string;
}

export function PlayPage({ manifest, scriptId }: PlayPageProps) {
  const goHome = useAppStore((s) => s.goHome);

  const handleBack = useCallback(() => {
    useGameStore.getState().reset();
    goHome();
  }, [goHome]);

  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="h-full bg-zinc-950 text-zinc-100 flex flex-col">
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
        <div className="relative">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={cn(
              'text-xs px-2 py-1 rounded transition-colors',
              showSettings
                ? 'text-zinc-200 bg-zinc-800'
                : 'text-zinc-500 hover:text-zinc-300',
            )}
          >
            ⚙ 设置
          </button>
          {showSettings && (
            <TypewriterPopover onClose={() => setShowSettings(false)} />
          )}
        </div>
      </header>

      {/* Play panel fills remaining space */}
      <div className="flex-1 min-h-0">
        <PlayPanel manifest={manifest} scriptId={scriptId} showDebug />
      </div>
    </div>
  );
}

// ============================================================================
// TypewriterPopover — 打字机速度弹出设置
// ============================================================================

function TypewriterPopover({ onClose }: { onClose: () => void }) {
  const [speed, setSpeed] = useState(() => getTypewriterSpeed());
  const ref = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const handleChange = (value: number) => {
    setSpeed(value);
    setTypewriterSpeed(value);
  };

  const presets = [
    { label: '慢', value: 20 },
    { label: '中', value: 60 },
    { label: '快', value: 150 },
    { label: '即时', value: 0 },
  ];

  return (
    <div
      ref={ref}
      className="absolute top-full right-0 mt-1 w-64 bg-zinc-900 border border-zinc-700 rounded-lg p-3 shadow-xl z-50 space-y-3"
    >
      <div className="text-xs font-medium text-zinc-300">打字机速度</div>
      <div className="flex items-center gap-3">
        <input
          type="range"
          min={0}
          max={200}
          value={speed === 0 ? 200 : speed}
          onChange={(e) => {
            const v = Number(e.target.value);
            handleChange(v >= 200 ? 0 : v);
          }}
          className="flex-1 accent-emerald-500 h-1"
        />
        <span className="text-[11px] text-zinc-400 font-mono w-16 text-right">
          {speed === 0 ? '即时' : `${speed} 字/秒`}
        </span>
      </div>
      <div className="flex gap-1.5">
        {presets.map((p) => (
          <button
            key={p.label}
            onClick={() => handleChange(p.value)}
            className={cn(
              'text-[10px] px-2 py-0.5 rounded border transition-colors',
              speed === p.value
                ? 'border-emerald-600 text-emerald-400 bg-emerald-950/30'
                : 'border-zinc-700 text-zinc-500 hover:text-zinc-300 hover:border-zinc-500',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-zinc-600">
        下一段生成时生效
      </p>
    </div>
  );
}
