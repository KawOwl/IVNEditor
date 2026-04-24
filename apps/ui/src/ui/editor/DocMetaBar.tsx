import { estimateTokens } from '@ivn/core/tokens';
import { cn } from '@/lib/utils';
import type { EditorDocument } from './editor-documents';

export function DocMetaBar({
  doc,
  onMetaChange,
  onRewrite,
  rewriting,
  rewriteProgress,
}: {
  doc: EditorDocument;
  onMetaChange: (
    field: 'role' | 'priority' | 'injectionCondition' | 'injectionDescription' | 'focusScene' | 'useDerived',
    value: string | number | boolean,
  ) => void;
  onRewrite?: () => void;
  rewriting?: boolean;
  rewriteProgress?: { segment: number; maxSegments: number } | null;
}) {
  const tokenCount = estimateTokens(doc.content);

  return (
    <div className="flex-none px-3 py-2 border-b border-zinc-800 flex items-center gap-3 text-xs flex-wrap">
      <span className="text-zinc-300 font-medium">{doc.filename}</span>

      <span className="text-zinc-700">|</span>

      <label className="flex items-center gap-1 text-zinc-500">
        Role:
        <select
          value={doc.role}
          onChange={(e) => onMetaChange('role', e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-zinc-300 text-xs focus:outline-none"
        >
          <option value="system">system</option>
          <option value="context">context</option>
          <option value="draft">draft</option>
        </select>
      </label>

      <label className="flex items-center gap-1 text-zinc-500">
        Priority:
        <input
          type="number"
          value={doc.priority}
          onChange={(e) => onMetaChange('priority', parseInt(e.target.value) || 0)}
          className="w-12 bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-zinc-300 text-xs text-center focus:outline-none"
          min={0}
          max={99}
        />
      </label>

      {doc.role === 'system' && onRewrite && (
        <>
          <span className="text-zinc-700">|</span>
          <button
            onClick={onRewrite}
            disabled={rewriting}
            className={cn(
              'px-2 py-0.5 rounded border text-[10px] font-medium transition-colors',
              rewriting
                ? 'border-zinc-700 text-zinc-500 cursor-wait'
                : 'border-violet-800/50 bg-violet-950/30 text-violet-400 hover:border-violet-600',
            )}
          >
            {rewriting ? 'AI 改写中...' : doc.derivedContent ? 'AI 重新改写' : 'AI 改写'}
          </button>
          {rewriting && rewriteProgress && rewriteProgress.segment > 0 && (
            <span className="text-[10px] text-zinc-500">
              续写 {rewriteProgress.segment} / {rewriteProgress.maxSegments}
            </span>
          )}
          {doc.derivedContent && (
            <label className="flex items-center gap-1 text-zinc-500 cursor-pointer">
              <input
                type="checkbox"
                checked={doc.useDerived ?? false}
                onChange={(e) => onMetaChange('useDerived', e.target.checked)}
                className="accent-violet-500"
              />
              <span className={doc.useDerived ? 'text-violet-400' : ''}>
                使用衍生版
              </span>
            </label>
          )}
        </>
      )}

      <label className="flex items-center gap-1 text-zinc-500 flex-1 min-w-0">
        Condition:
        <input
          type="text"
          value={doc.injectionCondition}
          onChange={(e) => onMetaChange('injectionCondition', e.target.value)}
          placeholder="空 = 始终注入"
          className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-300 text-xs font-mono placeholder:text-zinc-600 focus:outline-none"
        />
      </label>

      <label className="flex items-center gap-1 text-zinc-500 min-w-0">
        Scene:
        <input
          type="text"
          value={doc.focusScene}
          onChange={(e) => onMetaChange('focusScene', e.target.value)}
          placeholder="空 = 全局"
          className="w-28 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-zinc-300 text-xs font-mono placeholder:text-zinc-600 focus:outline-none"
          title="只在 state.current_scene 等于此值时，被标记为当前 focus 的相关 segment"
        />
      </label>

      <span className="text-zinc-600">~{tokenCount.toLocaleString()} tok</span>
    </div>
  );
}
