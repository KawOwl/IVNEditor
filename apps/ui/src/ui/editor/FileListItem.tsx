import { useCallback, useState } from 'react';
import type { MouseEvent } from 'react';
import { estimateTokens } from '@ivn/core/tokens';
import { cn } from '../../lib/utils';
import type { EditorDocument } from './editor-documents';

export function FileListItem({
  doc,
  selected,
  onSelect,
  onDelete,
  onRename,
}: {
  doc: EditorDocument;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (name: string) => void;
}) {
  const tokenCount = estimateTokens(doc.content);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(doc.filename);

  const handleDoubleClick = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    setEditName(doc.filename);
    setEditing(true);
  }, [doc.filename]);

  const handleRenameConfirm = useCallback(() => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== doc.filename) {
      onRename(trimmed.endsWith('.md') ? trimmed : trimmed + '.md');
    }
    setEditing(false);
  }, [editName, doc.filename, onRename]);

  return (
    <div
      onClick={onSelect}
      className={cn(
        'group px-3 py-1.5 cursor-pointer flex items-start gap-2 transition-colors',
        selected ? 'bg-zinc-800/60' : 'hover:bg-zinc-900/50',
      )}
    >
      <span className={cn(
        'flex-none mt-1.5 w-2 h-2 rounded-full',
        doc.role === 'system' ? 'bg-purple-500' :
        doc.role === 'draft' ? 'bg-zinc-500' :
        'bg-cyan-500',
      )} />

      <div className="flex-1 min-w-0">
        {editing ? (
          <input
            autoFocus
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={handleRenameConfirm}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleRenameConfirm();
              if (e.key === 'Escape') setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
            className="w-full text-xs px-1 py-0 bg-zinc-800 border border-zinc-600 rounded text-zinc-200 focus:outline-none"
          />
        ) : (
          <div
            onDoubleClick={handleDoubleClick}
            className={cn(
              'text-xs truncate',
              selected ? 'text-zinc-200' : 'text-zinc-400',
            )}
            title="双击重命名"
          >
            {doc.filename}
          </div>
        )}
        <div className="flex items-center gap-1.5 text-[10px] text-zinc-600">
          <span>{doc.role}</span>
          <span>P{doc.priority}</span>
          <span>~{tokenCount.toLocaleString()} tok</span>
        </div>
        {doc.injectionCondition && (
          <div className="text-[10px] text-amber-700 truncate">
            if: {doc.injectionCondition}
          </div>
        )}
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="flex-none mt-0.5 text-zinc-700 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all text-xs"
        title="删除"
      >
        ×
      </button>
    </div>
  );
}
