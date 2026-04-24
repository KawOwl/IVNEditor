/**
 * VersionHistoryList — 剧本版本历史列表（6.3）
 *
 * 显示当前剧本的所有版本（draft / published / archived），按 version_number
 * 降序。每行显示版本号、状态徽章、相对时间、label。当前编辑的版本有
 * 高亮；draft 版本可点"发布"按钮。
 *
 * 6.3 范围内只做只读展示 + 发布按钮，不做 diff 视图、不做 rollback。
 */

import { cn } from '@/lib/utils';

export interface VersionSummary {
  id: string;
  scriptId: string;
  versionNumber: number;
  label: string | null;
  status: 'draft' | 'published' | 'archived';
  contentHash: string;
  note: string | null;
  createdAt: string;
  publishedAt: string | null;
  archivedAt: string | null;
}

export interface VersionHistoryListProps {
  /** 当前编辑的版本 id，用于高亮 */
  currentVersionId: string | null;
  /** 当前剧本是否已被加载（没有 script 时列表为空） */
  hasScript: boolean;
  /** 版本列表（按 versionNumber 降序） */
  versions: VersionSummary[];
  /** 加载中标志 */
  loading?: boolean;
  /** 点击某个 version 时切换编辑对象 */
  onSelect: (versionId: string) => void;
  /** 发布一个 draft 版本 */
  onPublish: (versionId: string) => void;
  /** 发布中的 versionId（用于 disable 按钮） */
  publishingVersionId?: string | null;
}

// ============================================================================
// Helpers
// ============================================================================

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return '刚刚';
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)} 小时前`;
  if (ms < 30 * 86400_000) return `${Math.floor(ms / 86400_000)} 天前`;
  return new Date(iso).toLocaleDateString();
}

const STATUS_BADGE: Record<VersionSummary['status'], { label: string; cls: string }> = {
  draft: { label: '草稿', cls: 'text-amber-400 bg-amber-950/40 border-amber-800/50' },
  published: { label: '发布', cls: 'text-emerald-400 bg-emerald-950/40 border-emerald-800/50' },
  archived: { label: '归档', cls: 'text-zinc-500 bg-zinc-900/60 border-zinc-800' },
};

// ============================================================================
// Component
// ============================================================================

export function VersionHistoryList({
  currentVersionId,
  hasScript,
  versions,
  loading,
  onSelect,
  onPublish,
  publishingVersionId,
}: VersionHistoryListProps) {
  return (
    <div className="w-48 flex-none border-r border-zinc-800 flex flex-col">
      <div className="flex-none px-3 py-2 border-b border-zinc-800">
        <div className="text-[10px] text-zinc-500 uppercase tracking-wider">版本历史</div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {!hasScript ? (
          <div className="px-3 py-8 text-center text-[10px] text-zinc-600 leading-relaxed">
            保存剧本后
            <br />
            会生成第一个版本
          </div>
        ) : loading ? (
          <div className="px-3 py-8 text-center text-[10px] text-zinc-600">加载中...</div>
        ) : versions.length === 0 ? (
          <div className="px-3 py-8 text-center text-[10px] text-zinc-600">暂无版本</div>
        ) : (
          <div className="py-1">
            {versions.map((v) => {
              const isCurrent = v.id === currentVersionId;
              const badge = STATUS_BADGE[v.status];
              const timeIso = v.publishedAt ?? v.archivedAt ?? v.createdAt;
              const canPublish = v.status === 'draft';
              return (
                <div
                  key={v.id}
                  onClick={() => onSelect(v.id)}
                  className={cn(
                    'group px-3 py-2 cursor-pointer border-l-2 transition-colors',
                    isCurrent
                      ? 'border-l-emerald-600 bg-zinc-900'
                      : 'border-l-transparent hover:bg-zinc-900/60',
                  )}
                >
                  <div className="flex items-center justify-between gap-1.5 mb-0.5">
                    <span className="text-xs font-mono text-zinc-300">v{v.versionNumber}</span>
                    <span
                      className={cn(
                        'text-[9px] px-1.5 py-[1px] rounded border font-medium',
                        badge.cls,
                      )}
                    >
                      {badge.label}
                    </span>
                  </div>
                  {v.label && (
                    <div className="text-[10px] text-zinc-400 truncate mb-0.5">{v.label}</div>
                  )}
                  <div className="text-[9px] text-zinc-600">{formatRelativeTime(timeIso)}</div>
                  {canPublish && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onPublish(v.id);
                      }}
                      disabled={publishingVersionId === v.id}
                      className="mt-1 w-full text-[10px] py-0.5 rounded border border-emerald-800/50 text-emerald-400 hover:bg-emerald-950/40 disabled:opacity-40 transition-colors"
                    >
                      {publishingVersionId === v.id ? '发布中...' : '发布此版本'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
