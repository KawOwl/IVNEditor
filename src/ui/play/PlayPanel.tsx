/**
 * PlayPanel — 可复用的对话交互组件
 *
 * 核心对话模块：NarrativeView + InputPanel。
 * 不包含全屏布局和导航栏，可嵌入任何容器。
 *
 * 6.6 后：引擎永远在后端运行，PlayPanel 只走 WebSocket remote 路径。
 * editorMode 用来区分"编剧试玩"（走 scriptVersionId + kind=playtest）
 * 和"正式玩家"（走 scriptId + kind=production）。
 */

import { useCallback, useEffect, useRef } from 'react';
import { NarrativeView } from '../NarrativeView';
import { InputPanel } from '../InputPanel';
import { useGameStore } from '../../stores/game-store';
import {
  createRemoteSession,
  reconnectRemoteSession,
  getStoredPlaythroughId,
  type RemoteSession,
} from '../../stores/ws-client-emitter';
import type { ScriptManifest } from '../../core/types';
import { getBackendUrl } from '../../core/engine-mode';
import { cn } from '../../lib/utils';

// ============================================================================
// Types
// ============================================================================

export interface PlayPanelProps {
  /** 剧本数据 */
  manifest: ScriptManifest;
  /** 剧本 ID（玩家模式需要传给后端） */
  scriptId?: string;
  /**
   * 指定的游玩记录 ID
   *   - 真实 ID → 重连并恢复该游玩
   *   - 'new' → 创建新游玩（忽略 localStorage）
   *   - undefined → 回退到 localStorage 判断
   */
  playthroughId?: string | 'new';
  /** 紧凑模式（嵌入编辑器时使用，缩小字体） */
  compact?: boolean;
  /** 是否显示 debug 面板（6.6 后暂未启用） */
  showDebug?: boolean;
  /** 是否显示 LLM 推理过程 */
  showReasoning?: boolean;
  /**
   * 编辑器模式（编剧侧试玩）。
   *
   * 6.4 起：editorMode=true 时强制用 scriptVersionId 创建 kind='playtest'
   * 的 playthrough，让试玩走和正式玩家完全相同的 GameSession 代码路径，
   * 并被 Langfuse trace 完整覆盖。
   *
   * 必须配合 scriptVersionId prop 使用——没有当前 draft 版本时不能试玩。
   */
  editorMode?: boolean;
  /** 编辑器模式下要试玩的 script_version_id（loadedVersionId） */
  scriptVersionId?: string;
  /** 挂载后自动开始（列表选择模式下使用） */
  autoStart?: boolean;
}

// ============================================================================
// Component
// ============================================================================

export function PlayPanel({
  manifest,
  scriptId,
  playthroughId,
  compact = false,
  showReasoning = false,
  editorMode = false,
  scriptVersionId,
  autoStart = false,
}: PlayPanelProps) {
  const status = useGameStore((s) => s.status);
  const error = useGameStore((s) => s.error);

  const remoteRef = useRef<RemoteSession | null>(null);

  // Show opening messages on mount (only for new games, not when restoring)
  useEffect(() => {
    // 恢复模式下跳过 opening messages —— 避免在 restored 到达前闪现
    if (playthroughId && playthroughId !== 'new') return;

    const { entries } = useGameStore.getState();
    if (entries.length > 0) return; // already has content

    const { openingMessages } = manifest;
    if (openingMessages && openingMessages.length > 0) {
      const appendEntry = useGameStore.getState().appendEntry;
      for (const msg of openingMessages) {
        appendEntry({ role: 'system', content: msg });
      }
    }
  }, [manifest, playthroughId]);

  const handleStart = useCallback(async () => {
    if (remoteRef.current) return;

    // 编辑器模式必须有 scriptVersionId（否则没有可试玩的版本）
    if (editorMode && !scriptVersionId) {
      useGameStore.getState().setError('请先保存剧本（创建一个版本）后再试玩');
      return;
    }

    // 玩家模式用 scriptId 创建 playthrough（指向当前 published 版本）
    const playerScriptId = scriptId ?? manifest.id;
    if (!editorMode && !playerScriptId) {
      useGameStore.getState().setError('缺少剧本 ID');
      return;
    }

    try {
      useGameStore.getState().setStatus('loading');

      // 决定目标 playthroughId（仅玩家模式从 localStorage 恢复；
      // 编辑器模式每次都新建，不复用上次的试玩）
      const storageKey = editorMode
        ? `version:${scriptVersionId}`
        : playerScriptId!;
      const targetPtId =
        editorMode
          ? null  // 编辑器试玩永远新建（lossless 试玩快照）
          : playthroughId === 'new'
            ? null
            : playthroughId ?? getStoredPlaythroughId(storageKey);

      if (targetPtId) {
        // 恢复指定的游玩 —— 直接 WS 连接，服务端会自动发 'restored' 快照
        try {
          useGameStore.getState().reset();
          const remote = await reconnectRemoteSession(getBackendUrl(), targetPtId);
          remoteRef.current = remote;
          return;
        } catch (err) {
          console.warn('[PlayPanel] Reconnect failed, falling back to new session:', err);
        }
      }

      // 新建游玩
      const remote = editorMode
        ? await createRemoteSession(
            getBackendUrl(),
            { scriptVersionId: scriptVersionId! },
            { kind: 'playtest' },
          )
        : await createRemoteSession(getBackendUrl(), playerScriptId!, { kind: 'production' });
      remoteRef.current = remote;
      remote.start();
    } catch (err) {
      useGameStore.getState().setError(String(err));
    }
  }, [manifest, scriptId, playthroughId, editorMode, scriptVersionId]);

  // autoStart：挂载后自动触发开始（列表选择模式下使用）
  const didAutoStart = useRef(false);
  useEffect(() => {
    if (autoStart && !didAutoStart.current) {
      didAutoStart.current = true;
      handleStart();
    }
  }, [autoStart, handleStart]);

  const handlePlayerInput = useCallback((text: string) => {
    remoteRef.current?.submitInput(text);
  }, []);

  const handleStop = useCallback(() => {
    remoteRef.current?.stop();
    remoteRef.current?.disconnect();
    remoteRef.current = null;
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
        </div>
        <div className="flex items-center gap-1.5">
          {status === 'idle' && !remoteRef.current && (
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
    </div>
  );
}
