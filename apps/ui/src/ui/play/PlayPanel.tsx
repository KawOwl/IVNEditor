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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { InputPanel } from '#internal/ui/InputPanel';
import { VNStageContainer } from '#internal/ui/play/vn/VNStageContainer';
import { MemoryPanel } from '#internal/ui/play/MemoryPanel';
import { useGameStore } from '@/stores/game-store';
import {
  createRemoteSession,
  reconnectRemoteSession,
  getStoredPlaythroughId,
  clearStoredPlaythroughId,
  type RemoteSession,
} from '@/stores/ws-client-emitter';
import { fetchWithAuth } from '@/stores/player-session-store';
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
    setFeedbackOpen(true);
  }, []);

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
            title="提交问卷反馈"
            className="text-[11px] px-2 py-0.5 rounded text-zinc-600 hover:text-zinc-400 transition-colors"
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
        {/* ANN.1 Memory deletion annotation panel — Figma stage 1-2 */}
        <MemoryPanel playthroughId={currentPlaythroughId} />
      </div>

      {/* Input area */}
      <InputPanel onSubmit={handlePlayerInput} />

      {feedbackOpen && (
        <FeedbackModal
          playthroughId={currentPlaythroughId}
          onClose={handleCloseFeedback}
        />
      )}
    </div>
  );
}

// ============================================================================
// FeedbackModal — 5 题反馈问卷（PFB.1）
//
// 任何身份都能点反馈（anonymous 走 RegistrationGate 拦截不会到这）。
// 注册+画像走 RegistrationGate 全局 modal，跟反馈完全解耦（PFB.2 调整）。
//
// 反馈选项原文必须与后端 routes/feedback.mts FEEDBACK_OPTIONS 同步发布；
// 后端 zod enum 严格校验，前端漂移会 400 拦截。
// ============================================================================

const Q4_OTHER_LABEL = '其他';

const FEEDBACK_QUESTIONS = [
  {
    key: 'q1' as const,
    title: '您平时看剧情最常玩/用什么？',
    options: [
      '橙光/易次元等互动小说',
      '底特律变人、隐形守护者等单机剧情游戏',
      '线下剧本杀 / 跑团（TRPG） / 语C聊天',
      '基本只看纯文本的网文/传统小说',
    ],
  },
  {
    key: 'q2' as const,
    title: '您以前玩互动故事（或看小说）时，最让你受不了的点是什么？',
    options: [
      '角色像鱼的记忆，前面的选择后面全忘了',
      '剧情逻辑崩坏，角色强行降智',
      '选项全是假的，选什么最后结局都一样',
      '必须自己动脑子做选择，感觉太累了',
    ],
  },
  {
    key: 'q3' as const,
    title: '在体验《潜台词》这款产品时，你觉得哪个功能/体验最吸引你？',
    options: [
      '给我一个输入框自由打字,AI真的能懂我的意思并接上剧情',
      '生成的剧情文本质量很高，逻辑严密不降智',
      '既有现成的选项，关键时候也能自己打字，两不误',
    ],
  },
  {
    key: 'q4' as const,
    title: '在以往使用同类AI或互动App时，你曾经为了什么内容付费？',
    options: [
      '购买体力/次数：为了能继续和AI对话或开启新剧情',
      '购买"后悔药"：为了回溯剧情，修改之前选错的决定',
      '解锁内容：为了看隐藏结局、番外或精美角色立绘',
      '尚未付费过，通常只体验免费部分',
      Q4_OTHER_LABEL,
    ],
  },
  {
    key: 'q5' as const,
    title: '您能接受AI参与互动小说创作到哪种程度？',
    options: [
      '仅辅助生成选项文案',
      '生成次要支线/NPC的实时互动',
      '生成主线关键剧情',
      '完全不接受AI，纯人工创作最好',
    ],
  },
] as const;

type FeedbackAnswerKey = typeof FEEDBACK_QUESTIONS[number]['key'];
type FeedbackAnswers = Partial<Record<FeedbackAnswerKey, string>>;

function FeedbackModal({
  playthroughId,
  onClose,
}: {
  playthroughId: string | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<'survey' | 'bug'>('survey');
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[85vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Tab bar */}
        <div className="flex-none flex border-b border-zinc-800">
          <button
            type="button"
            onClick={() => setTab('survey')}
            className={cn(
              'flex-1 px-4 py-2.5 text-xs font-medium transition-colors',
              tab === 'survey'
                ? 'text-zinc-100 border-b-2 border-emerald-600'
                : 'text-zinc-500 hover:text-zinc-300',
            )}
          >
            问卷
          </button>
          <button
            type="button"
            onClick={() => setTab('bug')}
            className={cn(
              'flex-1 px-4 py-2.5 text-xs font-medium transition-colors',
              tab === 'bug'
                ? 'text-zinc-100 border-b-2 border-emerald-600'
                : 'text-zinc-500 hover:text-zinc-300',
            )}
          >
            Bug 反馈
          </button>
        </div>

        {tab === 'survey' ? (
          <FeedbackForm playthroughId={playthroughId} onClose={onClose} />
        ) : (
          <BugReportForm playthroughId={playthroughId} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

// ============================================================================
// BugReportForm — 单个 textarea → POST /api/bug-reports（PFB.3）
// ============================================================================

const BUG_DESCRIPTION_MAX_LEN = 5000;

function BugReportForm({
  playthroughId,
  onClose,
}: {
  playthroughId: string | null;
  onClose: () => void;
}) {
  // turn 跟 useGameStore 走 canonical 来源；不做 'playthroughId 为 null
  // 时清 turn' 的转换 —— stop / unmount 后 useGameStore.totalTurns 留着上
  // 一轮数字是已知行为，分析时 join 到 playthrough 即可定位上下文
  const turn = useGameStore((s) => s.totalTurns);
  const [description, setDescription] = useState('');
  const [submitState, setSubmitState] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const trimmed = description.trim();
  const canSubmit =
    submitState !== 'submitting' && submitState !== 'success' && trimmed.length > 0;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitState('submitting');
    setErrorMsg(null);
    try {
      const res = await fetchWithAuth(`${getBackendUrl()}/api/bug-reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playthroughId, turn, description: trimmed }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: '提交失败' }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setSubmitState('success');
      setTimeout(onClose, 1500);
    } catch (err) {
      setSubmitState('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [canSubmit, onClose, playthroughId, trimmed, turn]);

  if (submitState === 'success') {
    return (
      <div className="flex-1 flex items-center justify-center px-5 py-12">
        <p className="text-sm text-emerald-400">已收到，谢谢你的反馈 🎉</p>
      </div>
    );
  }

  return (
    <>
      <div className="flex-none px-5 py-4 border-b border-zinc-800">
        <p className="text-[11px] text-zinc-500 leading-relaxed">
          描述一下你遇到的 bug——我们会用当前游玩 ID 关联到完整 trace
          重放。复现步骤、预期效果、实际效果一起写更好。
        </p>
      </div>
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={BUG_DESCRIPTION_MAX_LEN}
          disabled={submitState === 'submitting'}
          placeholder="请描述你遇到的 bug…"
          rows={10}
          className="w-full px-3 py-2 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs leading-relaxed focus:outline-none focus:border-emerald-600 resize-y"
          autoFocus
        />
        <p className="mt-1 text-right text-[11px] text-zinc-600">
          {description.length}/{BUG_DESCRIPTION_MAX_LEN}
        </p>
      </div>
      <div className="flex-none px-5 py-3 border-t border-zinc-800 flex items-center gap-2">
        <span
          className={cn(
            'text-[11px] flex-1',
            submitState === 'error' ? 'text-red-400' : 'text-zinc-500',
          )}
        >
          {submitState === 'error' && (errorMsg ?? '提交失败，请重试')}
          {submitState === 'submitting' && '提交中…'}
        </span>
        <button
          type="button"
          onClick={onClose}
          disabled={submitState === 'submitting'}
          className="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 disabled:opacity-50 transition-colors"
        >
          取消
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="text-xs px-3 py-1.5 rounded bg-emerald-700 text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          提交
        </button>
      </div>
    </>
  );
}


// ============================================================================
// FeedbackForm — 5 题问卷 → POST /api/feedback（PFB.1 原逻辑搬过来）
// ============================================================================

function FeedbackForm({
  playthroughId,
  onClose,
}: {
  playthroughId: string | null;
  onClose: () => void;
}) {
  const [answers, setAnswers] = useState<FeedbackAnswers>({});
  const [q4Other, setQ4Other] = useState('');
  const [submitState, setSubmitState] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const showQ4Other = answers.q4 === Q4_OTHER_LABEL;

  const canSubmit = useMemo(() => {
    if (submitState === 'submitting' || submitState === 'success') return false;
    if (FEEDBACK_QUESTIONS.some((q) => !answers[q.key])) return false;
    if (showQ4Other && q4Other.trim().length === 0) return false;
    return true;
  }, [answers, q4Other, showQ4Other, submitState]);

  const handleSelect = useCallback((key: FeedbackAnswerKey, value: string) => {
    setAnswers((prev) => ({ ...prev, [key]: value }));
    if (key === 'q4' && value !== Q4_OTHER_LABEL) {
      setQ4Other('');
    }
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setSubmitState('submitting');
    setErrorMsg(null);
    try {
      const res = await fetchWithAuth(`${getBackendUrl()}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          playthroughId,
          q1: answers.q1,
          q2: answers.q2,
          q3: answers.q3,
          q4: answers.q4,
          q4Other: showQ4Other ? q4Other.trim() : null,
          q5: answers.q5,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: '提交失败' }));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setSubmitState('success');
      // 1.5s 后自动关
      setTimeout(onClose, 1500);
    } catch (err) {
      setSubmitState('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }, [answers, canSubmit, onClose, playthroughId, q4Other, showQ4Other]);

  if (submitState === 'success') {
    return (
      <>
        <div className="flex-none px-5 py-4 border-b border-zinc-800">
          <h2 className="text-sm font-medium text-zinc-200">反馈问卷（5 题）</h2>
        </div>
        <div className="flex-1 flex items-center justify-center px-5 py-12">
          <p className="text-sm text-emerald-400">已收到，谢谢你的反馈 🎉</p>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="flex-none px-5 py-4 border-b border-zinc-800">
        <h2 className="text-sm font-medium text-zinc-200">反馈问卷（5 题）</h2>
        <p className="text-[11px] text-zinc-500 mt-1">
          谢谢你的参与。每题只需选一个选项，全部填完后即可提交。
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">
        {FEEDBACK_QUESTIONS.map((q, idx) => (
          <fieldset key={q.key} className="space-y-2">
            <legend className="text-xs text-zinc-300 leading-relaxed">
              <span className="text-zinc-500 mr-1">{idx + 1}.</span>
              <span className="text-red-400 mr-1">*</span>
              {q.title}
            </legend>
            <div className="space-y-1.5 pl-4">
              {q.options.map((opt) => {
                const checked = answers[q.key] === opt;
                return (
                  <label
                    key={opt}
                    className={cn(
                      'flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer text-xs leading-relaxed',
                      checked
                        ? 'bg-emerald-900/30 text-zinc-100'
                        : 'text-zinc-400 hover:bg-zinc-800/60',
                    )}
                  >
                    <input
                      type="radio"
                      name={q.key}
                      value={opt}
                      checked={checked}
                      onChange={() => handleSelect(q.key, opt)}
                      disabled={submitState === 'submitting'}
                      className="mt-0.5 accent-emerald-600"
                    />
                    <span>{opt}</span>
                  </label>
                );
              })}
            </div>
            {q.key === 'q4' && showQ4Other && (
              <div className="pl-4">
                <input
                  type="text"
                  value={q4Other}
                  onChange={(e) => setQ4Other(e.target.value)}
                  maxLength={500}
                  placeholder="请填写你付费过的内容（≤ 500 字）"
                  disabled={submitState === 'submitting'}
                  className="w-full px-3 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs focus:outline-none focus:border-emerald-600"
                  autoFocus
                />
              </div>
            )}
          </fieldset>
        ))}
      </div>

      <div className="flex-none px-5 py-3 border-t border-zinc-800 flex items-center gap-2">
        <span
          className={cn(
            'text-[11px] flex-1',
            submitState === 'error' ? 'text-red-400' : 'text-zinc-500',
          )}
        >
          {submitState === 'error' && (errorMsg ?? '提交失败，请重试')}
          {submitState === 'submitting' && '提交中…'}
        </span>
        <button
          type="button"
          onClick={onClose}
          disabled={submitState === 'submitting'}
          className="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 disabled:opacity-50 transition-colors"
        >
          取消
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="text-xs px-3 py-1.5 rounded bg-emerald-700 text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          提交
        </button>
      </div>
    </>
  );
}
