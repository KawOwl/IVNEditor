/**
 * ScriptCard — 首页小说卡片
 *
 * 展示剧本封面、标题、简介、标签。
 * 点击进入对话页。
 */

import type { ScriptCatalogEntry } from '../../core/types';
import { cn } from '../../lib/utils';

export interface ScriptCardProps {
  entry: ScriptCatalogEntry;
  onClick: () => void;
  onUnpublish?: () => void;
}

export function ScriptCard({ entry, onClick, onUnpublish }: ScriptCardProps) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'group relative rounded-xl overflow-hidden',
        'bg-zinc-900 border border-zinc-800',
        'hover:border-zinc-600 hover:shadow-lg hover:shadow-zinc-900/50',
        'transition-all duration-200 text-left cursor-pointer',
        'flex flex-col',
      )}
    >
      {/* Cover image area */}
      <div className="aspect-[3/4] bg-gradient-to-br from-zinc-800 to-zinc-900 relative overflow-hidden">
        {entry.coverImage ? (
          <img
            src={entry.coverImage}
            alt={entry.label}
            className="w-full h-full object-cover"
          />
        ) : (
          /* Placeholder cover with decorative pattern */
          <div className="w-full h-full flex items-center justify-center">
            <div className="absolute inset-0 opacity-10">
              <div className="absolute top-4 left-4 w-20 h-20 rounded-full border border-zinc-500" />
              <div className="absolute bottom-8 right-6 w-32 h-32 rounded-full border border-zinc-500" />
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-16 h-16 rounded-full border-2 border-zinc-400" />
            </div>
            <span className="text-3xl font-bold text-zinc-600 z-10">
              {entry.label.charAt(0)}
            </span>
          </div>
        )}

        {/* Gradient overlay at bottom */}
        <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-zinc-900 to-transparent" />

        {/* Chapter count badge */}
        <div className="absolute top-3 right-3 bg-black/60 backdrop-blur-sm rounded-full px-2 py-0.5 text-[10px] text-zinc-300">
          {entry.chapterCount} 章
        </div>

        {/* Version badge */}
        {entry.version && (
          <div className="absolute top-3 left-3 bg-black/60 backdrop-blur-sm rounded-full px-2 py-0.5 text-[10px] text-zinc-400 font-mono">
            v{entry.version}
          </div>
        )}

        {/* Unpublish button (admin only) */}
        {onUnpublish && (
          <button
            onClick={(e) => { e.stopPropagation(); onUnpublish(); }}
            className="absolute bottom-2 right-2 z-10 bg-red-900/80 backdrop-blur-sm text-red-300 hover:bg-red-800 hover:text-red-200 rounded px-2 py-0.5 text-[10px] transition-colors"
            title="下架此剧本"
          >
            下架
          </button>
        )}
      </div>

      {/* Info area */}
      <div className="p-4 flex-1 flex flex-col gap-2">
        <h3 className="text-sm font-medium text-zinc-200 group-hover:text-white transition-colors line-clamp-1">
          {entry.label}
        </h3>

        {entry.description && (
          <p className="text-xs text-zinc-500 line-clamp-2 leading-relaxed">
            {entry.description}
          </p>
        )}

        {/* Tags */}
        {entry.tags && entry.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-auto pt-2">
            {entry.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        {/* Author */}
        {entry.author && (
          <div className="text-[10px] text-zinc-600 mt-1">
            by {entry.author}
          </div>
        )}
      </div>
    </div>
  );
}
