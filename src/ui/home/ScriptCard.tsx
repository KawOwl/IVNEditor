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
        'group relative rounded overflow-hidden',
        'bg-zinc-900 border border-zinc-800',
        'hover:border-zinc-600 hover:shadow-lg hover:shadow-zinc-900/50',
        'transition-all duration-200 text-left cursor-pointer',
        'flex flex-col',
      )}
    >
      {/* Card body — cover image as background */}
      <div
        className="aspect-[9/16] relative overflow-hidden flex flex-col"
        style={entry.coverImage ? {
          backgroundImage: `url(${entry.coverImage})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        } : undefined}
      >
        {/* Dark overlay for readability (always present) */}
        <div className={cn(
          'absolute inset-0',
          entry.coverImage
            ? 'bg-gradient-to-b from-black/80 via-black/50 to-black/70'
            : 'bg-gradient-to-br from-zinc-800 to-zinc-900',
        )} />

        {/* Text content */}
        <div className="relative z-10 p-4 flex-1 flex flex-col gap-2">
          <h3 className="text-base font-semibold text-zinc-100 group-hover:text-white transition-colors line-clamp-2 leading-snug">
            {entry.label}
          </h3>

          {entry.description && (
            <p className="text-xs text-zinc-400 leading-relaxed flex-1 overflow-hidden">
              {entry.description}
            </p>
          )}

          {/* Spacer when no description */}
          {!entry.description && <div className="flex-1" />}

          {/* Tags — always above badges */}
          {entry.tags && entry.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {entry.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag}
                  className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-700/60 text-zinc-400"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          {/* Bottom row: badges + author */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              <span className="bg-black/60 backdrop-blur-sm rounded px-2 py-0.5 text-[10px] text-zinc-300">
                {entry.chapterCount} 章
              </span>
            </div>
            {entry.author && (
              <span className="text-[10px] text-zinc-500">
                by {entry.author}
              </span>
            )}
          </div>
        </div>

        {/* Unpublish button (admin only) — top-right corner, visible on hover */}
        {onUnpublish && (
          <button
            onClick={(e) => { e.stopPropagation(); onUnpublish(); }}
            className="absolute top-3 right-3 z-20 opacity-0 group-hover:opacity-100 bg-red-900/80 backdrop-blur-sm text-red-300 hover:bg-red-800 hover:text-red-200 rounded px-2 py-0.5 text-[10px] transition-all"
            title="下架此剧本"
          >
            下架
          </button>
        )}
      </div>
    </div>
  );
}
