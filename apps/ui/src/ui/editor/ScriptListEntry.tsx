import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

export interface ScriptListItem {
  id: string;
  label: string;
  description: string;
  updatedAt: number;
  fileCount: number;
  published?: boolean;
  tags?: string[];
}

export function ScriptListEntry({
  item,
  isActive,
  onLoad,
  onRename,
  onDelete,
}: {
  item: ScriptListItem;
  isActive: boolean;
  onLoad: (id: string) => void;
  onRename: (id: string, newLabel: string) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(item.label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commitRename = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== item.label) {
      onRename(item.id, trimmed);
    } else {
      setEditValue(item.label);
    }
    setEditing(false);
  };

  return (
    <div
      className={cn(
        'px-2 py-1.5 flex items-center gap-1.5 cursor-pointer hover:bg-zinc-800 transition-colors',
        isActive && 'bg-zinc-800/60',
      )}
      onClick={() => !editing && onLoad(item.id)}
    >
      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            ref={inputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') { setEditValue(item.label); setEditing(false); }
            }}
            onClick={(e) => e.stopPropagation()}
            className="w-full text-xs px-1 py-0.5 bg-zinc-800 border border-zinc-600 rounded text-zinc-200 outline-none"
          />
        ) : (
          <div className="text-xs text-zinc-300 truncate">
            {item.label}
            {item.published && <span className="ml-1 text-[9px] text-emerald-500">已发布</span>}
          </div>
        )}
        <div className="text-[10px] text-zinc-600">
          {new Date(item.updatedAt).toLocaleDateString()}
        </div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setEditValue(item.label);
          setEditing(true);
        }}
        className="flex-none text-zinc-600 hover:text-zinc-300 transition-colors text-[10px]"
        title="重命名"
      >
        ✎
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (confirm(`确认删除「${item.label}」？`)) {
            onDelete(item.id);
          }
        }}
        className="flex-none text-zinc-600 hover:text-red-400 transition-colors text-xs"
        title="删除"
      >
        ×
      </button>
    </div>
  );
}
