/**
 * PlayPanel — 可复用的对话交互组件
 *
 * 核心对话模块：NarrativeView + InputPanel + 可选 DebugPanel。
 * 不包含全屏布局和导航栏，可嵌入任何容器。
 *
 * 使用场景：
 *   - PlayPage（全屏对话）
 *   - EditorPage 右侧试玩面板
 */

import { useCallback, useEffect, useRef } from 'react';
import { NarrativeView } from '../NarrativeView';
import { InputPanel } from '../InputPanel';
import { DebugPanel } from '../DebugPanel';
import { useGameStore } from '../../stores/game-store';
import { GameSession } from '../../core/game-session';
import type { GameSessionConfig } from '../../core/game-session';
import type { ScriptManifest } from '../../core/types';
import { cn } from '../../lib/utils';

// ============================================================================
// Types
// ============================================================================

export interface PlayPanelProps {
  /** 剧本数据 */
  manifest: ScriptManifest;
  /** 紧凑模式（嵌入编辑器时使用，隐藏 debug、缩小字体） */
  compact?: boolean;
  /** 是否显示 debug 面板 */
  showDebug?: boolean;
}

// ============================================================================
// LLM Config helper（从环境变量读取）
// ============================================================================

function getLLMConfig() {
  return {
    provider: 'openai-compatible' as const,
    baseURL: import.meta.env.VITE_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
    apiKey: import.meta.env.VITE_DEEPSEEK_API_KEY ?? '',
    model: import.meta.env.VITE_DEEPSEEK_MODEL ?? 'deepseek-chat',
    name: 'deepseek',
  };
}

// ============================================================================
// Component
// ============================================================================

export function PlayPanel({ manifest, compact = false, showDebug = true }: PlayPanelProps) {
  const status = useGameStore((s) => s.status);
  const error = useGameStore((s) => s.error);
  const sessionRef = useRef<GameSession | null>(null);

  // Show opening messages on mount (only if store is empty)
  useEffect(() => {
    const { entries } = useGameStore.getState();
    if (entries.length > 0) return; // already has content

    const { openingMessages } = manifest;
    if (openingMessages && openingMessages.length > 0) {
      const appendEntry = useGameStore.getState().appendEntry;
      for (const msg of openingMessages) {
        appendEntry({ role: 'system', content: msg });
      }
    }
  }, [manifest]);

  const handleStart = useCallback(() => {
    if (sessionRef.current) return;

    const chapter = manifest.chapters[0];
    if (!chapter) return;

    const config: GameSessionConfig = {
      chapterId: chapter.id,
      segments: chapter.segments,
      stateSchema: manifest.stateSchema,
      memoryConfig: manifest.memoryConfig,
      enabledTools: manifest.enabledTools,
      initialPrompt: manifest.initialPrompt,
      llmConfig: getLLMConfig(),
    };

    const session = new GameSession();
    sessionRef.current = session;
    session.start(config);
  }, [manifest]);

  const handlePlayerInput = useCallback((text: string) => {
    sessionRef.current?.submitInput(text);
  }, []);

  const handleStop = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = null;
  }, []);

  const handleReset = useCallback(() => {
    handleStop();
    useGameStore.getState().reset();
    // Re-show opening messages
    const { openingMessages } = manifest;
    if (openingMessages && openingMessages.length > 0) {
      const appendEntry = useGameStore.getState().appendEntry;
      for (const msg of openingMessages) {
        appendEntry({ role: 'system', content: msg });
      }
    }
  }, [handleStop, manifest]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      sessionRef.current?.stop();
      sessionRef.current = null;
      // Don't reset store here — let the parent decide when to reset
      // (PlayPage resets in handleBack, EditorPage resets on tab switch)
    };
  }, []);

  return (
    <div className={cn('flex flex-col h-full', compact && 'text-sm')}>
      {/* Controls bar */}
      <div className="flex-none px-3 py-2 border-b border-zinc-800 flex items-center justify-between">
        <span className={cn(
          'text-xs font-medium',
          status === 'generating' ? 'text-amber-400' :
          status === 'waiting-input' ? 'text-emerald-400' :
          status === 'error' ? 'text-red-400' :
          'text-zinc-500',
        )}>
          {status === 'idle' ? '就绪' :
           status === 'generating' ? '生成中...' :
           status === 'waiting-input' ? '等待输入' :
           status === 'compressing' ? '压缩中...' :
           status === 'loading' ? '加载中...' :
           status === 'error' ? '错误' : status}
        </span>
        <div className="flex items-center gap-1.5">
          {status === 'idle' && !sessionRef.current && (
            <button
              onClick={handleStart}
              className="text-[11px] px-2 py-0.5 rounded bg-emerald-700 hover:bg-emerald-600 text-white transition-colors"
            >
              开始
            </button>
          )}
          {status !== 'idle' && status !== 'error' && (
            <button
              onClick={handleStop}
              className="text-[11px] px-2 py-0.5 rounded text-zinc-500 hover:text-red-400 transition-colors"
            >
              停止
            </button>
          )}
          <button
            onClick={handleReset}
            className="text-[11px] px-2 py-0.5 rounded text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            重置
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex-none px-3 py-1.5 bg-red-950/50 border-b border-red-900/50 text-red-300 text-xs">
          {error}
        </div>
      )}

      {/* Narrative area */}
      <NarrativeView />

      {/* Input area */}
      <InputPanel onSubmit={handlePlayerInput} />

      {/* Debug panel (optional) */}
      {showDebug && !compact && <DebugPanel />}
    </div>
  );
}
