/**
 * PlayPage — 全屏对话页面
 *
 * 两个阶段：
 *   1. 游玩列表 — 选择继续/新建
 *   2. PlayPanel — 游戏主界面
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useAppStore } from '@/stores/app-store';
import { useGameStore } from '@/stores/game-store';
import { PlayPanel } from './PlayPanel';
import { PlaythroughList } from './PlaythroughList';
import { getTypewriterSpeed, setTypewriterSpeed } from './typewriter-speed';
import type { ScriptManifest } from '@ivn/core/types';
import { cn } from '@/lib/utils';

export interface PlayPageProps {
  manifest: ScriptManifest;
  scriptId: string;
}

export function PlayPage({ manifest, scriptId }: PlayPageProps) {
  const goHome = useAppStore((s) => s.goHome);

  // null = 未选择（显示列表），'new' = 新建，其他字符串 = 具体的 playthroughId
  const [selection, setSelection] = useState<string | 'new' | null>(null);

  const handleBack = useCallback(() => {
    if (selection !== null) {
      // 从游戏返回列表
      useGameStore.getState().reset();
      setSelection(null);
    } else {
      // 返回首页
      useGameStore.getState().reset();
      goHome();
    }
  }, [goHome, selection]);

  const handleSelect = useCallback((playthroughId: string | 'new') => {
    // 进入游戏前清空 store
    useGameStore.getState().reset();
    setSelection(playthroughId);
  }, []);

  const [showSettings, setShowSettings] = useState(false);

  const inGame = selection !== null;

  return (
    <div className="h-full bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Header */}
      <header className="flex-none px-6 py-3 border-b border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={handleBack}
            className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            ← {inGame ? '返回列表' : '返回'}
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

      {/* Content */}
      <div className="flex-1 min-h-0">
        {inGame ? (
          <PlayPanel
            key={selection ?? 'new'}
            manifest={manifest}
            scriptId={scriptId}
            playthroughId={selection ?? undefined}
            autoStart
            showDebug
          />
        ) : (
          <PlaythroughList
            scriptId={scriptId}
            scriptTitle={manifest.label}
            onSelect={handleSelect}
          />
        )}
      </div>
    </div>
  );
}

// ============================================================================
// TypewriterPopover
// ============================================================================

function TypewriterPopover({ onClose }: { onClose: () => void }) {
  const [speed, setSpeed] = useState(() => getTypewriterSpeed());
  const ref = useRef<HTMLDivElement>(null);

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
      className="absolute top-full right-0 mt-1 w-64 bg-zinc-900 border border-zinc-700 rounded p-3 shadow-xl z-50 space-y-3"
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
