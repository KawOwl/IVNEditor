/**
 * App — 主应用布局
 *
 * 三区布局：
 *   - NarrativeView: 叙事区域（可滚动，占满剩余空间）
 *   - InputPanel: 输入区域（底部固定）
 *   - DebugPanel: 调试面板（底部可折叠）
 *
 * 通过 GameSession 实例连接引擎核心。
 */

import { useCallback, useRef } from 'react';
import { NarrativeView } from './NarrativeView';
import { InputPanel } from './InputPanel';
import { DebugPanel } from './DebugPanel';
import { useGameStore } from '../stores/game-store';
import { GameSession } from '../core/game-session';
import type { GameSessionConfig } from '../core/game-session';
import { module7TestManifest } from '../fixtures/module7-test';

export function App() {
  const status = useGameStore((s) => s.status);
  const error = useGameStore((s) => s.error);
  const sessionRef = useRef<GameSession | null>(null);

  const handleStart = useCallback(() => {
    if (sessionRef.current) return;

    const chapter = module7TestManifest.chapters[0]!;
    const config: GameSessionConfig = {
      chapterId: chapter.id,
      segments: chapter.segments,
      stateSchema: module7TestManifest.stateSchema,
      memoryConfig: module7TestManifest.memoryConfig,
      enabledTools: module7TestManifest.enabledTools,
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
  }, []);

  const handlePlayerInput = useCallback(
    (text: string) => {
      sessionRef.current?.submitInput(text);
    },
    [],
  );

  const handleStop = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = null;
  }, []);

  return (
    <div className="h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Header */}
      <header className="flex-none px-6 py-3 border-b border-zinc-800 flex items-center justify-between">
        <h1 className="text-sm font-medium text-zinc-400">
          Interactive Novel Engine
        </h1>
        <div className="flex items-center gap-3">
          {status === 'idle' && !sessionRef.current && (
            <button
              onClick={handleStart}
              className="text-xs px-3 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white transition-colors"
            >
              Start MODULE_7
            </button>
          )}
          {status !== 'idle' && status !== 'error' && (
            <button
              onClick={handleStop}
              className="text-xs text-zinc-500 hover:text-red-400 transition-colors"
            >
              Stop
            </button>
          )}
          <div className="text-xs text-zinc-600">v2.0</div>
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

export { type GameSessionConfig };
export { App as default };

/**
 * Helper to start a game session from outside React.
 * Usage: startGame(config) from a script loader or test harness.
 */
export function createGameStarter() {
  let session: GameSession | null = null;

  return {
    start: (config: GameSessionConfig) => {
      session = new GameSession();
      session.start(config);
      return session;
    },
    submitInput: (text: string) => {
      session?.submitInput(text);
    },
    stop: () => {
      session?.stop();
      session = null;
    },
  };
}
