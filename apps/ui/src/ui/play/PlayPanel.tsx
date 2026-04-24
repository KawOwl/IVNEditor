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
import { InputPanel } from '../InputPanel';
import { VNStageContainer } from './vn/VNStageContainer';
import { useGameStore } from '@/stores/game-store';
import {
  createRemoteSession,
  reconnectRemoteSession,
  getStoredPlaythroughId,
  clearStoredPlaythroughId,
  type RemoteSession,
} from '@/stores/ws-client-emitter';
import type { ScriptManifest } from '@ivn/core/types';
import { getBackendUrl } from '@/lib/backend-url';
import { cn } from '@/lib/utils';

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
  /**
   * v2.7：显式指定本次 playthrough 使用的 LLM 配置 id。
   *
   * 使用场景：
   *   - 玩家流：由 PublicScriptInfo.productionLlmConfigId 透传（App.tsx PlayPageLoader）
   *   - 编辑器试玩流：由编辑器"试玩使用 LLM"dropdown 传入（admin 个人偏好）
   *
   * 为空时后端按 fallback 链选一套（script.productionLlmConfigId → 最早的 llm_config），
   * 所以非必填。
   */
  llmConfigId?: string | null;
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
  // showReasoning — 暂时保留 prop 接口避免调用方报错；M1 VN 视图下 reasoning
  // 展示由 EditorDebugPanel 的 "raw streaming" tab（Step 1.7）承担
  showReasoning: _showReasoning = false,
  editorMode = false,
  scriptVersionId,
  llmConfigId,
  autoStart = false,
}: PlayPanelProps) {
  void _showReasoning;
  const status = useGameStore((s) => s.status);
  const error = useGameStore((s) => s.error);

  const remoteRef = useRef<RemoteSession | null>(null);

  // Seed opening messages on mount (only for new games, not when restoring).
  //
  // M1 Step 1.3：老的 appendEntry(role:'system') → synthetic narration Sentence。
  // 走和 LLM 产出一样的管线（parsedSentences），让 VN UI 从第一句开场就能
  // click-to-advance。
  useEffect(() => {
    // 恢复模式下跳过 opening —— 服务端会重放真实 Sentences，不要盖一层假开场
    if (playthroughId && playthroughId !== 'new') return;

    const { parsedSentences } = useGameStore.getState();
    if (parsedSentences.length > 0) return; // already has content

    const { openingMessages, defaultScene } = manifest;
    if (openingMessages && openingMessages.length > 0) {
      useGameStore.getState().seedOpeningSentences(
        openingMessages,
        defaultScene ?? { background: null, sprites: [] },
      );
    }
  }, [manifest, playthroughId]);

  /**
   * 建立一个"全新的 playthrough"远程会话。不尝试重连。
   *
   * 独立拎出来是因为 handleStart 和 handleReset 都要用这段逻辑：
   * - handleStart 在首次挂载 / 选"新游戏"时调
   * - handleReset 在玩家点"重置"时调（此时先归档老的再新建）
   *
   * 返回 false 表示校验失败（缺参数等），调用方不应该继续。
   */
  const startNewRemoteSession = useCallback(async (): Promise<boolean> => {
    // 编辑器模式必须有 scriptVersionId（否则没有可试玩的版本）
    if (editorMode && !scriptVersionId) {
      useGameStore.getState().setError('请先保存剧本（创建一个版本）后再试玩');
      return false;
    }
    const playerScriptId = scriptId ?? manifest.id;
    if (!editorMode && !playerScriptId) {
      useGameStore.getState().setError('缺少剧本 ID');
      return false;
    }
    try {
      useGameStore.getState().setStatus('loading');
      const remote = editorMode
        ? await createRemoteSession(
            getBackendUrl(),
            { scriptVersionId: scriptVersionId! },
            { kind: 'playtest', llmConfigId },
          )
        : await createRemoteSession(
            getBackendUrl(),
            playerScriptId!,
            { kind: 'production', llmConfigId },
          );
      remoteRef.current = remote;
      remote.start();
      return true;
    } catch (err) {
      useGameStore.getState().setError(String(err));
      return false;
    }
  }, [editorMode, scriptVersionId, scriptId, manifest, llmConfigId]);

  const handleStart = useCallback(async () => {
    if (remoteRef.current) return;

    // 先看 playthroughId prop / localStorage 能否走重连
    if (editorMode && !scriptVersionId) {
      useGameStore.getState().setError('请先保存剧本（创建一个版本）后再试玩');
      return;
    }
    const playerScriptId = scriptId ?? manifest.id;
    if (!editorMode && !playerScriptId) {
      useGameStore.getState().setError('缺少剧本 ID');
      return;
    }

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
        useGameStore.getState().setStatus('loading');
        useGameStore.getState().reset();
        const remote = await reconnectRemoteSession(getBackendUrl(), targetPtId);
        remoteRef.current = remote;
        return;
      } catch (err) {
        console.warn('[PlayPanel] Reconnect failed, falling back to new session:', err);
      }
    }

    // 新建游玩
    await startNewRemoteSession();
  }, [manifest, scriptId, playthroughId, editorMode, scriptVersionId, startNewRemoteSession]);

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

  /**
   * 重置 = 和当前 playthrough 分手 + 启动一个全新的 playthrough。
   *
   * **不归档**老的——玩家之后可以在"游玩记录"列表里点进去回顾。
   * 老的 playthrough 仍然以它当前的状态（waiting-input / finished /
   * generating 随便哪个）留在 DB 里，列表会照常展示。用户如果想继续
   * 那次游玩，直接点列表里的它即可 reconnect。
   *
   * 具体步骤：
   *   1. 断开当前 WS，清前端 store
   *   2. 重放 opening messages
   *   3. 清掉 localStorage 里"上次游玩 id"（防止下次 fallback 到老的）
   *      —— 即便不清，startNewRemoteSession 创建新会话后也会覆盖它，
   *      但显式清掉能兜底"新会话创建失败"的路径。
   *   4. 立刻调 startNewRemoteSession 创建一条全新 playthrough
   *
   * 历史：v2.7 早期版本曾经 PATCH archived:true 归档老的，但这样
   * 老记录就从列表里消失、玩家没法回顾。按用户反馈改成保留。
   */
  const handleReset = useCallback(async () => {
    handleStop();
    useGameStore.getState().reset();
    // Re-seed opening as synthetic narration Sentences（与 mount 逻辑保持一致）
    const { openingMessages, defaultScene } = manifest;
    if (openingMessages && openingMessages.length > 0) {
      useGameStore.getState().seedOpeningSentences(
        openingMessages,
        defaultScene ?? { background: null, sprites: [] },
      );
    }

    // 清 localStorage 的"上次游玩 id"
    // 玩家流用 scriptId 做 key；编辑器试玩用 scriptVersionId
    const storageKey = editorMode
      ? (scriptVersionId ? `version:${scriptVersionId}` : null)
      : (scriptId ?? manifest.id ?? null);
    if (storageKey) clearStoredPlaythroughId(storageKey);

    // 立刻启动新 playthrough
    await startNewRemoteSession();
  }, [
    handleStop,
    manifest,
    editorMode,
    scriptVersionId,
    scriptId,
    startNewRemoteSession,
  ]);

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
            status === 'finished' ? 'text-violet-400' :
            status === 'error' ? 'text-red-400' :
            'text-zinc-500',
          )}>
            {status === 'idle' ? '就绪' :
             status === 'generating' ? '生成中...' :
             status === 'waiting-input' ? '等待输入' :
             status === 'compressing' ? '压缩中...' :
             status === 'loading' ? '加载中...' :
             status === 'finished' ? '剧情已结束' :
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

      {/* VN stage area — M1 Step 1.2：VN 渲染替代老 NarrativeView 气泡视图 */}
      <div className="relative flex-1 min-h-0 bg-black">
        <VNStageContainer
          characters={manifest.characters ?? []}
          backgrounds={manifest.backgrounds ?? []}
        />
      </div>

      {/* Input area */}
      <InputPanel onSubmit={handlePlayerInput} />
    </div>
  );
}
