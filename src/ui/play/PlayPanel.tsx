/**
 * PlayPanel — 可复用的对话交互组件
 *
 * 核心对话模块：NarrativeView + InputPanel + 可选 DebugPanel。
 * 不包含全屏布局和导航栏，可嵌入任何容器。
 *
 * 使用场景：
 *   - PlayPage（全屏对话）— 根据 engineMode 选择 local 或 remote
 *   - EditorPage 右侧试玩面板 — 始终 local（编剧自带 API key）
 */

import { useCallback, useEffect, useRef } from 'react';
import { NarrativeView } from '../NarrativeView';
import { InputPanel } from '../InputPanel';
import { DebugPanel } from '../DebugPanel';
import { useGameStore } from '../../stores/game-store';
import { GameSession } from '../../core/game-session';
import type { GameSessionConfig } from '../../core/game-session';
import { createLocalEmitter } from '../../stores/local-session-emitter';
import {
  createRemoteSession,
  reconnectRemoteSession,
  getStoredPlaythroughId,
  type RemoteSession,
} from '../../stores/ws-client-emitter';
import type { ScriptManifest } from '../../core/types';
import { getTextLLMConfig, useLLMSettingsStore } from '../../stores/llm-settings-store';
import { getEngineMode, getBackendUrl } from '../../core/engine-mode';
import { cn } from '../../lib/utils';

// ============================================================================
// Types
// ============================================================================

export interface PlayPanelProps {
  /** 剧本数据 */
  manifest: ScriptManifest;
  /** 剧本 ID（remote 模式需要传给后端） */
  scriptId?: string;
  /** 紧凑模式（嵌入编辑器时使用，隐藏 debug、缩小字体） */
  compact?: boolean;
  /** 是否显示 debug 面板 */
  showDebug?: boolean;
  /** 是否显示 LLM 推理过程（debug 模式） */
  showReasoning?: boolean;
  /** 强制使用 local 模式（编辑器试玩始终 local） */
  forceLocal?: boolean;
}

// ============================================================================
// Component
// ============================================================================

export function PlayPanel({
  manifest,
  scriptId,
  compact = false,
  showDebug = true,
  showReasoning = false,
  forceLocal = false,
}: PlayPanelProps) {
  const status = useGameStore((s) => s.status);
  const error = useGameStore((s) => s.error);

  // Local mode refs
  const sessionRef = useRef<GameSession | null>(null);
  // Remote mode refs
  const remoteRef = useRef<RemoteSession | null>(null);

  const mode = forceLocal ? 'local' : getEngineMode();

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

  const handleStart = useCallback(async () => {
    if (mode === 'remote') {
      // Remote mode: connect to backend via WebSocket
      if (remoteRef.current) return;

      const id = scriptId ?? manifest.id;
      if (!id) {
        useGameStore.getState().setError('缺少剧本 ID');
        return;
      }

      try {
        useGameStore.getState().setStatus('loading');

        // 检查是否有保存的 playthroughId（可恢复的游玩）
        const storedPtId = getStoredPlaythroughId(id);
        if (storedPtId) {
          // 尝试重连
          try {
            const remote = await reconnectRemoteSession(getBackendUrl(), storedPtId);
            remoteRef.current = remote;
            remote.restore(); // 从 DB 恢复
            return;
          } catch {
            // 重连失败（playthrough 已删除等），回退到新建
            console.warn('[PlayPanel] Reconnect failed, starting new session');
          }
        }

        // 新建游玩
        const remote = await createRemoteSession(getBackendUrl(), id);
        remoteRef.current = remote;
        remote.start();
      } catch (err) {
        useGameStore.getState().setError(String(err));
      }
    } else {
      // Local mode: run engine in browser
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
        assemblyOrder: manifest.promptAssemblyOrder,
        disabledSections: manifest.disabledAssemblySections,
        llmConfig: getTextLLMConfig(),
      };

      const session = new GameSession(createLocalEmitter());
      sessionRef.current = session;
      session.start(config);
    }
  }, [manifest, scriptId, mode]);

  // 即时同步 LLM 设置变更到活跃会话（无需重启）
  const thinkingEnabled = useLLMSettingsStore((s) => s.thinkingEnabled);
  const reasoningFilterEnabled = useLLMSettingsStore((s) => s.reasoningFilterEnabled);
  useEffect(() => {
    sessionRef.current?.updateLLMConfig({ thinkingEnabled, reasoningFilterEnabled });
  }, [thinkingEnabled, reasoningFilterEnabled]);

  const handlePlayerInput = useCallback((text: string) => {
    if (mode === 'remote') {
      remoteRef.current?.submitInput(text);
    } else {
      sessionRef.current?.submitInput(text);
    }
  }, [mode]);

  const handleStop = useCallback(() => {
    if (mode === 'remote') {
      remoteRef.current?.stop();
      remoteRef.current?.disconnect();
      remoteRef.current = null;
    } else {
      sessionRef.current?.stop();
      sessionRef.current = null;
    }
  }, [mode]);

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
      remoteRef.current?.disconnect();
      remoteRef.current = null;
    };
  }, []);

  return (
    <div className={cn('flex flex-col h-full', compact && 'text-sm')}>
      {/* Controls bar */}
      <div className="flex-none px-3 py-2 border-b border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
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
          {/* Mode indicator */}
          <span className="text-[10px] text-zinc-600">
            {mode === 'remote' ? '[远程]' : '[本地]'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          {status === 'idle' && !sessionRef.current && !remoteRef.current && (
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
      <NarrativeView showReasoning={showReasoning} />

      {/* Input area */}
      <InputPanel onSubmit={handlePlayerInput} />

      {/* Debug panel (optional, only in local mode) */}
      {showDebug && !compact && mode === 'local' && <DebugPanel />}
    </div>
  );
}
