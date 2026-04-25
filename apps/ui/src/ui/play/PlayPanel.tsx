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

import { useCallback, useEffect, useRef, useState } from 'react';
import { InputPanel } from '#internal/ui/InputPanel';
import { VNStageContainer } from '#internal/ui/play/vn/VNStageContainer';
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
  // remoteRef 是 ref 不触发渲染，用 state 同步当前真实的 playthroughId 给反馈按钮
  const [currentPlaythroughId, setCurrentPlaythroughId] = useState<string | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

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
      setCurrentPlaythroughId(remote.playthroughId);
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

    // 决定目标 playthroughId：
    //   - 显式 'new' → 永远新建
    //   - 显式 uuid → 两种模式都尊重，恢复指定的 playthrough
    //                （编辑器模式下"载入历史试玩存档"必须靠这条路径）
    //   - 缺省       → 编辑器模式新建（lossless 试玩快照不复用上次）；
    //                   玩家模式回落到 localStorage 的"上次游玩 id"
    const storageKey = editorMode
      ? `version:${scriptVersionId}`
      : playerScriptId!;
    let targetPtId: string | null;
    if (playthroughId === 'new') {
      targetPtId = null;
    } else if (playthroughId) {
      targetPtId = playthroughId;
    } else {
      targetPtId = editorMode ? null : getStoredPlaythroughId(storageKey);
    }

    if (targetPtId) {
      // 恢复指定的游玩 —— 直接 WS 连接，服务端会自动发 'restored' 快照
      try {
        useGameStore.getState().setStatus('loading');
        useGameStore.getState().reset();
        const remote = await reconnectRemoteSession(getBackendUrl(), targetPtId);
        remoteRef.current = remote;
        setCurrentPlaythroughId(remote.playthroughId);
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
    setCurrentPlaythroughId(null);
  }, []);

  const handleOpenFeedback = useCallback(() => {
    if (!currentPlaythroughId) return;
    setFeedbackOpen(true);
  }, [currentPlaythroughId]);

  const handleCloseFeedback = useCallback(() => setFeedbackOpen(false), []);

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
          <button
            onClick={handleOpenFeedback}
            disabled={!currentPlaythroughId}
            title={
              currentPlaythroughId
                ? '查看并复制当前 playthroughId 用于反馈'
                : '游戏未开始，无 playthroughId 可复制'
            }
            className="text-[11px] px-2 py-0.5 rounded text-zinc-600 hover:text-zinc-400 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            反馈
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

      {feedbackOpen && currentPlaythroughId && (
        <FeedbackModal
          playthroughId={currentPlaythroughId}
          onClose={handleCloseFeedback}
        />
      )}
    </div>
  );
}

// ============================================================================
// FeedbackModal — 显示当前 playthroughId 供用户复制贴到反馈渠道
//
// 不只走 navigator.clipboard.writeText：那个 API 在 http / 焦点不在 / 沙箱
// iframe 等场景会静默失败。Modal 里同时 render 一个 readOnly input + autoFocus
// + select()，用户即便复制按钮失败也能 ⌘C 兜底。
// ============================================================================

function FeedbackModal({
  playthroughId,
  onClose,
}: {
  playthroughId: string;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(playthroughId);
      setCopyState('copied');
    } catch {
      // clipboard API 没权限：input 已经 select，提示用户 ⌘C
      inputRef.current?.select();
      setCopyState('failed');
    }
  }, [playthroughId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[28rem] max-w-[90vw] bg-zinc-900 border border-zinc-700 rounded p-5 space-y-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-sm font-medium text-zinc-200">反馈 · 当前游玩 ID</h2>
        <p className="text-[11px] text-zinc-400 leading-relaxed">
          把下面这串 ID 一起发给开发者，方便定位你这局的日志和数据库记录。
        </p>
        <input
          ref={inputRef}
          type="text"
          value={playthroughId}
          readOnly
          onFocus={(e) => e.currentTarget.select()}
          style={{ fontSize: 12 }}
          className="w-full font-mono px-3 py-2 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 focus:outline-none focus:border-zinc-500 select-all"
        />
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'text-[11px] flex-1',
              copyState === 'copied' && 'text-emerald-400',
              copyState === 'failed' && 'text-amber-400',
              copyState === 'idle' && 'text-zinc-500',
            )}
          >
            {copyState === 'copied' && '已复制到剪贴板'}
            {copyState === 'failed' && '剪贴板失败，请手动 ⌘C / Ctrl+C 复制'}
            {copyState === 'idle' && ''}
          </span>
          <button
            type="button"
            onClick={handleCopy}
            className="text-xs px-3 py-1.5 rounded bg-emerald-700 text-white hover:bg-emerald-600 transition-colors"
          >
            复制
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
