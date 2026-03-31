/**
 * PlayPage — 对话页面
 *
 * 从首页点击卡片进入，展示互动叙事对话界面。
 * 包含：顶部导航栏 + NarrativeView + InputPanel + DebugPanel
 * 支持 openingMessages 静态开场 + initialPrompt 触发 LLM 生成。
 */

import { useCallback, useEffect, useRef } from 'react';
import { NarrativeView } from '../NarrativeView';
import { InputPanel } from '../InputPanel';
import { DebugPanel } from '../DebugPanel';
import { useGameStore } from '../../stores/game-store';
import { useAppStore } from '../../stores/app-store';
import { GameSession } from '../../core/game-session';
import type { GameSessionConfig } from '../../core/game-session';
import type { ScriptManifest } from '../../core/types';

export interface PlayPageProps {
  manifest: ScriptManifest;
}

export function PlayPage({ manifest }: PlayPageProps) {
  const status = useGameStore((s) => s.status);
  const error = useGameStore((s) => s.error);
  const goHome = useAppStore((s) => s.goHome);
  const sessionRef = useRef<GameSession | null>(null);
  const openingShownRef = useRef(false);

  // Show opening messages on mount
  useEffect(() => {
    if (openingShownRef.current) return;
    openingShownRef.current = true;

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

    const chapter = manifest.chapters[0]!;
    const config: GameSessionConfig = {
      chapterId: chapter.id,
      segments: chapter.segments,
      stateSchema: manifest.stateSchema,
      memoryConfig: manifest.memoryConfig,
      enabledTools: manifest.enabledTools,
      initialPrompt: manifest.initialPrompt,
      llmConfig: {
        provider: 'openai-compatible',
        baseURL: import.meta.env.VITE_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
        apiKey: import.meta.env.VITE_DEEPSEEK_API_KEY ?? '',
        model: import.meta.env.VITE_DEEPSEEK_MODEL ?? 'deepseek-chat',
        name: 'deepseek',
      },
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

  const handleBack = useCallback(() => {
    // Clean up session
    sessionRef.current?.stop();
    sessionRef.current = null;
    useGameStore.getState().reset();
    openingShownRef.current = false;
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
        <div className="flex items-center gap-3">
          {status === 'idle' && !sessionRef.current && (
            <button
              onClick={handleStart}
              className="text-xs px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white transition-colors"
            >
              开始游戏
            </button>
          )}
          {status !== 'idle' && status !== 'error' && (
            <button
              onClick={handleStop}
              className="text-xs text-zinc-500 hover:text-red-400 transition-colors"
            >
              停止
            </button>
          )}
        </div>
      </header>

      {/* Error banner */}
      {error && (
        <div className="flex-none px-6 py-2 bg-red-950/50 border-b border-red-900/50 text-red-300 text-sm">
          {error}
        </div>
      )}

      {/* Narrative area */}
      <NarrativeView />

      {/* Input area */}
      <InputPanel onSubmit={handlePlayerInput} />

      {/* Debug panel */}
      <DebugPanel />
    </div>
  );
}
