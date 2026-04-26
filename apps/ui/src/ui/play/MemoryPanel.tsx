/**
 * MemoryPanel —— ANN.1：玩家面"角色当前记忆"浮层
 *
 * 设计来源：Figma 6coZ2woF3y0ybLGSoWQZK3 阶段 1-2。
 * Step 1 范围：列出本 turn 的 memory entries → 点击划痕 → 弹 4 chip reason
 * picker → 提交后 5s 撤销窗。不做：重新构思（Step 2）/ 👍👎（Step 2）。
 *
 * 数据来源：game-store.memoryRetrievals[最后一个].entries（去重 by id 跨 source）
 *           + game-store.memoryDeletions（标注状态）
 *
 * 副标题文案"AI 将在下一轮调整"明牌降低期望（D3=c）—— 当前轮已生成内容不变，
 * 仅下一轮 retrieve 排除被标 entry。
 */

import { useEffect, useMemo, useState } from 'react';
import {
  useGameStore,
  type MemoryDeletionView,
  type MemoryReasonCode,
  type MemoryRetrievalEntry,
} from '@/stores/game-store';
import {
  callMarkDeleted,
  callCancelDeletion,
  callListTurnRetrievals,
} from '#internal/ui/play/memory-ops-client';
import { cn } from '@/lib/utils';

// ============================================================================
// Reason 中文映射 + chip 顺序
// ============================================================================

const REASON_OPTIONS: Array<{ code: MemoryReasonCode; label: string }> = [
  { code: 'character-broken', label: '人设崩塌' },
  { code: 'memory-confused', label: '记忆错乱' },
  { code: 'logic-error', label: '逻辑错误' },
  { code: 'other', label: '其他...' },
];

const REASON_LABEL: Record<MemoryReasonCode, string> = Object.fromEntries(
  REASON_OPTIONS.map((o) => [o.code, o.label]),
) as Record<MemoryReasonCode, string>;

// ============================================================================
// Props
// ============================================================================

export interface MemoryPanelProps {
  playthroughId: string | null;
}

// ============================================================================
// Component
// ============================================================================

export function MemoryPanel({ playthroughId }: MemoryPanelProps) {
  const memoryRetrievals = useGameStore((s) => s.memoryRetrievals);
  const memoryDeletions = useGameStore((s) => s.memoryDeletions);
  const setMemoryDeletions = useGameStore((s) => s.setMemoryDeletions);
  const appendMemoryRetrieval = useGameStore((s) => s.appendMemoryRetrieval);
  const markMemoryDeletedLocal = useGameStore((s) => s.markMemoryDeletedLocal);
  const expireMemoryDeletionCancellable = useGameStore((s) => s.expireMemoryDeletionCancellable);
  const removeMemoryDeletion = useGameStore((s) => s.removeMemoryDeletion);

  // 进入 playthrough 时拉一次历史 retrieval：
  //   - 标注集合（已忘掉灰态）
  //   - 最近的 retrieval（避免重连后 status=waiting-input、没新 generate 触发，
  //     panel 空白看不见）。WS 后续新 retrieval 通过 appendMemoryRetrieval 推。
  useEffect(() => {
    if (!playthroughId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await callListTurnRetrievals({ playthroughId, limit: 5 });
        if (cancelled) return;
        setMemoryDeletions(r.activeDeletions);
        // 把最近的 retrieval 倒序 append（service 已 desc，让最新在 store 末尾）
        for (const ret of [...r.retrievals].reverse()) {
          appendMemoryRetrieval({
            retrievalId: ret.id,
            turn: ret.turn,
            source: ret.source,
            query: ret.query,
            entries: ret.entries.map((e) => ({
              id: e.id,
              turn: e.turn,
              role: e.role,
              content: e.content,
              tokenCount: e.tokenCount,
              timestamp: e.timestamp,
              ...(e.pinned !== undefined ? { pinned: e.pinned } : {}),
            })),
            summary: ret.summary,
          });
        }
      } catch (err) {
        console.warn('[MemoryPanel] initial fetch failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [playthroughId, setMemoryDeletions, appendMemoryRetrieval]);

  // 当前展示的 memory entries：取最后一个 retrieval 的 entries
  // （Step 1 简化：实际可能多个 source，但通常 context-assembly 的最后一个就够）
  const currentEntries = useMemo(() => {
    if (memoryRetrievals.length === 0) return [];
    const latest = memoryRetrievals[memoryRetrievals.length - 1];
    if (!latest) return [];
    // 去重 by id
    const seen = new Set<string>();
    return latest.entries.filter((e) => {
      if (seen.has(e.id)) return false;
      seen.add(e.id);
      return true;
    });
  }, [memoryRetrievals]);

  // 当前 retrieval 的 id（mark_deleted 需要）
  const currentRetrievalId = memoryRetrievals[memoryRetrievals.length - 1]?.retrievalId ?? null;

  // 折叠状态 —— 常驻 header，玩家可主动收起减少干扰；
  // localStorage 持久化让重连后保持上次选择
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('ivn-memory-panel-collapsed') === '1';
    } catch {
      return false;
    }
  });
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('ivn-memory-panel-collapsed', next ? '1' : '0');
      } catch {
        // ignore
      }
      return next;
    });
  };

  return (
    <div
      className={cn(
        'absolute right-4 top-4 z-30 rounded-md p-3 text-sm text-white transition-all',
        collapsed ? 'w-44' : 'w-72',
      )}
      style={{
        background: 'linear-gradient(180deg, rgba(180,160,80,0.85) 0%, rgba(160,140,60,0.78) 100%)',
        boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
      }}
    >
      <div className={cn(
        'flex items-center justify-between font-semibold tracking-wide',
        collapsed ? '' : 'mb-1 border-b border-white/30 pb-1',
      )}>
        <span>{'>>'} 角色当前记忆 / memories</span>
        <button
          type="button"
          onClick={toggleCollapsed}
          className="ml-2 rounded px-1 text-xs leading-none text-white/80 hover:bg-white/15 hover:text-white"
          aria-label={collapsed ? '展开记忆面板' : '收起记忆面板'}
          title={collapsed ? '展开' : '收起'}
        >
          {collapsed ? '▽' : '△'}
        </button>
      </div>
      {!collapsed && (
        <>
          <div className="mb-2 flex items-start gap-1 text-xs text-amber-100">
            <span className="text-red-400">⚠</span>
            <span>点击划掉混乱记忆 · AI 将在下一轮调整</span>
          </div>
          {currentEntries.length === 0 ? (
            <div className="text-xs text-white/60 italic">
              本轮 AI 没有调用相关记忆
            </div>
          ) : (
            <ul className="space-y-1">
              {currentEntries.map((entry, idx) => (
          <MemoryEntryRow
            key={entry.id}
            index={idx + 1}
            entry={entry}
            deletion={memoryDeletions[entry.id]}
            disabled={!currentRetrievalId}
            onMark={async (reasonCode, reasonText) => {
              if (!currentRetrievalId) return;
              // 乐观写入临时 annotation（用 entry.id 作 placeholder annotationId）
              const placeholderId = `pending-${entry.id}-${Date.now()}`;
              markMemoryDeletedLocal({
                annotationId: placeholderId,
                memoryEntryId: entry.id,
                reasonCode,
              });
              try {
                const result = await callMarkDeleted({
                  turnMemoryRetrievalId: currentRetrievalId,
                  memoryEntryId: entry.id,
                  reasonCode,
                  reasonText,
                });
                // 用真实 annotation 替换 placeholder
                removeMemoryDeletion(placeholderId);
                markMemoryDeletedLocal({
                  annotationId: result.annotationId,
                  memoryEntryId: entry.id,
                  reasonCode: result.reasonCode,
                });
                // 5s 撤销窗到期
                setTimeout(() => {
                  expireMemoryDeletionCancellable(result.annotationId);
                }, 5000);
              } catch (err) {
                // 回滚乐观写入
                removeMemoryDeletion(placeholderId);
                console.error('[MemoryPanel] mark failed:', err);
                alert('标记失败，请稍后再试');
              }
            }}
            onCancel={async (annotationId) => {
              try {
                await callCancelDeletion({ annotationId });
              } catch (err) {
                console.warn('[MemoryPanel] cancel failed:', err);
              }
              // 不管 op 成功失败都撤回本地（op 失败说明窗已过，UI 反正也要 hide cancel）
              removeMemoryDeletion(annotationId);
            }}
          />
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

// ============================================================================
// Per-entry row
// ============================================================================

interface MemoryEntryRowProps {
  index: number;
  entry: MemoryRetrievalEntry;
  deletion: MemoryDeletionView | undefined;
  disabled: boolean;
  onMark: (reasonCode: MemoryReasonCode, reasonText?: string) => void | Promise<void>;
  onCancel: (annotationId: string) => void | Promise<void>;
}

function MemoryEntryRow({ index, entry, deletion, disabled, onMark, onCancel }: MemoryEntryRowProps) {
  const [showReasons, setShowReasons] = useState(false);
  const [otherText, setOtherText] = useState('');

  // 已经被标的 entry —— 灰态显示
  if (deletion) {
    return (
      <li className="flex flex-col text-xs">
        <span className="line-through text-white/40">
          [{index}] {truncate(entry.content, 28)}
        </span>
        <span className="text-amber-200/70">
          已忘掉 · {REASON_LABEL[deletion.reasonCode]}
          {deletion.cancellable && (
            <button
              type="button"
              onClick={() => onCancel(deletion.annotationId)}
              className="ml-2 underline hover:text-white"
            >
              撤销
            </button>
          )}
        </span>
      </li>
    );
  }

  // 未标 —— 默认显示纯文本，点击后展开 chip
  return (
    <li className="text-xs">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setShowReasons((v) => !v)}
        className={cn(
          'block w-full text-left transition hover:text-amber-100',
          showReasons && 'line-through text-white/60',
        )}
      >
        [{index}] {truncate(entry.content, 28)}
      </button>
      {showReasons && (
        <div className="mt-1 flex flex-wrap gap-1 rounded bg-black/20 p-1">
          {REASON_OPTIONS.map((opt) => (
            <button
              key={opt.code}
              type="button"
              onClick={async () => {
                if (opt.code === 'other') {
                  // 'other' 不立即提交，等用户填文本
                  return;
                }
                setShowReasons(false);
                await onMark(opt.code);
              }}
              className="rounded bg-white/10 px-2 py-0.5 text-[10px] text-white hover:bg-white/25"
            >
              {opt.label}
            </button>
          ))}
          {/* "其他" 文本框 */}
          <div className="mt-1 flex w-full gap-1">
            <input
              type="text"
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              maxLength={200}
              placeholder="其他原因（可选填）"
              className="flex-1 rounded bg-white/15 px-1 text-[10px] text-white placeholder:text-white/40"
            />
            <button
              type="button"
              onClick={async () => {
                setShowReasons(false);
                await onMark('other', otherText.trim() || undefined);
                setOtherText('');
              }}
              className="rounded bg-amber-500/80 px-2 py-0.5 text-[10px] text-white hover:bg-amber-500"
            >
              提交
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}
