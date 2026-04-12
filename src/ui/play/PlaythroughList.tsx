/**
 * PlaythroughList — 游玩记录列表
 *
 * 远程模式下，进入游戏前显示该剧本的所有游玩记录。
 * 玩家可以选择继续已有游玩或开始新游戏。
 */

import { useState, useEffect, useCallback } from 'react';
import { getBackendUrl } from '../../core/engine-mode';
import { fetchWithAuth } from '../../stores/player-session-store';
import { cn } from '../../lib/utils';

// ============================================================================
// Types
// ============================================================================

interface PlaythroughItem {
  id: string;
  title: string | null;
  turn: number;
  status: string;
  preview: string | null;
  createdAt: string;
  updatedAt: string;
  /** 该 playthrough 创建时所在的剧本版本号（如 3 → 显示 "v3"） */
  versionNumber: number | null;
  /** 该版本在当前的状态：'draft' | 'published' | 'archived' */
  versionStatus: string | null;
}

interface PlaythroughListProps {
  scriptId: string;
  scriptTitle: string;
  onSelect: (playthroughId: string | 'new') => void;
}

// ============================================================================
// Component
// ============================================================================

export function PlaythroughList({ scriptId, onSelect }: PlaythroughListProps) {
  const [items, setItems] = useState<PlaythroughItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchList = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      // 玩家侧只显示 kind=production 的记录，避免把 admin 自己的编辑器
      // 试玩（kind=playtest）混进玩家 UI 里
      const res = await fetchWithAuth(
        `${getBackendUrl()}/api/playthroughs?scriptId=${scriptId}&kind=production`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setItems(data.playthroughs ?? []);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [scriptId]);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('确定删除这条游玩记录？此操作不可撤销。')) return;

    setDeletingId(id);
    try {
      const res = await fetchWithAuth(`${getBackendUrl()}/api/playthroughs/${id}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setItems((prev) => prev.filter((item) => item.id !== id));
      }
    } catch {
      // silent
    } finally {
      setDeletingId(null);
    }
  }, []);

  const handleArchive = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const res = await fetchWithAuth(`${getBackendUrl()}/api/playthroughs/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      });
      if (res.ok) {
        setItems((prev) => prev.filter((item) => item.id !== id));
      }
    } catch {
      // silent
    }
  }, []);

  return (
    <div className="h-full overflow-y-auto px-6 py-6 max-w-2xl mx-auto space-y-4">
      {/* New game button */}
      <button
        onClick={() => onSelect('new')}
        className="w-full px-4 py-4 rounded-lg border-2 border-dashed border-zinc-700 text-zinc-400 hover:border-emerald-700 hover:text-emerald-400 transition-colors text-sm"
      >
        + 开始新游戏
      </button>

      {/* Loading */}
      {loading && (
        <div className="text-center text-zinc-600 text-sm py-8">
          加载游玩记录...
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="text-center text-red-400 text-sm py-4">
          {error}
          <button onClick={fetchList} className="ml-2 text-zinc-400 hover:text-zinc-200 underline">
            重试
          </button>
        </div>
      )}

      {/* List */}
      {!loading && items.length === 0 && !error && (
        <div className="text-center text-zinc-600 text-sm py-8">
          还没有游玩记录，开始第一次冒险吧
        </div>
      )}

      {items.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs text-zinc-600 px-1">游玩记录</div>
          {items.map((item) => (
            <PlaythroughCard
              key={item.id}
              item={item}
              deleting={deletingId === item.id}
              onContinue={() => onSelect(item.id)}
              onArchive={(e) => handleArchive(item.id, e)}
              onDelete={(e) => handleDelete(item.id, e)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// PlaythroughCard
// ============================================================================

function PlaythroughCard({
  item,
  deleting,
  onContinue,
  onArchive,
  onDelete,
}: {
  item: PlaythroughItem;
  deleting: boolean;
  onContinue: () => void;
  onArchive: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const isActive = item.status === 'waiting-input' || item.status === 'idle';
  const isFinished = item.status === 'finished';
  const updatedAt = new Date(item.updatedAt);
  const dateStr = formatDate(updatedAt);

  return (
    <div
      onClick={onContinue}
      className={cn(
        'rounded-lg border px-4 py-3 cursor-pointer transition-colors group',
        'border-zinc-800 hover:border-zinc-600 bg-zinc-900/50 hover:bg-zinc-900',
        deleting && 'opacity-50 pointer-events-none',
      )}
    >
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-200">
            {item.title ?? '未命名'}
          </span>
          <span className={cn(
            'text-[10px] px-1.5 py-0.5 rounded',
            isActive
              ? 'bg-emerald-950/50 text-emerald-400'
              : isFinished
                ? 'bg-violet-950/50 text-violet-400'
                : 'bg-zinc-800 text-zinc-500',
          )}>
            {item.status === 'waiting-input' ? '进行中' :
             item.status === 'idle' ? '就绪' :
             item.status === 'generating' ? '生成中' :
             item.status === 'finished' ? '已完结' :
             item.status}
          </span>
          {/* 版本号：永远显示；archived 的版本（已经被新版本取代）额外加"旧版"提示 */}
          {item.versionNumber !== null && (
            <span
              className={cn(
                'text-[10px] px-1.5 py-0.5 rounded font-mono',
                item.versionStatus === 'archived'
                  ? 'bg-amber-950/50 text-amber-500/80'
                  : 'bg-zinc-800/60 text-zinc-500',
              )}
              title={
                item.versionStatus === 'archived'
                  ? '此游玩记录创建时所用的剧本版本已被更新后的版本取代'
                  : undefined
              }
            >
              v{item.versionNumber}
              {item.versionStatus === 'archived' ? ' · 旧版' : ''}
            </span>
          )}
        </div>
        <span className="text-[10px] text-zinc-600">
          {dateStr} · 第{item.turn}轮
        </span>
      </div>

      {/* Preview */}
      {item.preview && (
        <p className="text-xs text-zinc-500 line-clamp-2 mb-2">
          {item.preview}
        </p>
      )}

      {/* Actions */}
      <div className="flex items-center justify-between">
        <button
          onClick={(e) => { e.stopPropagation(); onContinue(); }}
          className="text-[11px] px-3 py-1 rounded bg-emerald-900/40 border border-emerald-800/50 text-emerald-400 hover:bg-emerald-800/40 hover:text-emerald-300 transition-colors"
        >
          {isActive ? '继续' : '回顾'}
        </button>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={onArchive}
            className="text-[10px] px-2 py-0.5 text-zinc-600 hover:text-zinc-400 transition-colors"
          >
            归档
          </button>
          <button
            onClick={onDelete}
            className="text-[10px] px-2 py-0.5 text-zinc-600 hover:text-red-400 transition-colors"
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function formatDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return `今天 ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  }
  if (diffDays === 1) return '昨天';
  if (diffDays < 7) return `${diffDays}天前`;
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}
