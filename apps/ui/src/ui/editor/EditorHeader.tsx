import { cn } from '@/lib/utils';

export interface EditorHeaderProps {
  scriptLabel: string;
  loadedScriptId: string | null;
  documentCount: number;
  tokenCount: number;
  publishing: boolean;
  isPublished: boolean;
  onGoHome: () => void;
  onPublish: () => void;
}

export function EditorHeader({
  scriptLabel,
  loadedScriptId,
  documentCount,
  tokenCount,
  publishing,
  isPublished,
  onGoHome,
  onPublish,
}: EditorHeaderProps) {
  return (
    <header className="flex-none px-4 py-2.5 border-b border-zinc-800 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <button
          onClick={onGoHome}
          className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          ← 返回
        </button>
        <h1 className="text-sm font-medium text-zinc-300">编剧编辑器</h1>
        {loadedScriptId && (
          <span className="text-xs text-zinc-500">— {scriptLabel}</span>
        )}
      </div>

      <div className="flex items-center gap-3 text-xs text-zinc-500">
        <span>{documentCount} 个文件</span>
        <span className="text-zinc-700">|</span>
        <span>~{tokenCount.toLocaleString()} tokens</span>
        <span className="text-zinc-700">|</span>
        <button
          onClick={onPublish}
          disabled={!loadedScriptId || publishing}
          className={cn(
            'px-2.5 py-1 rounded text-[11px] font-medium transition-colors disabled:opacity-40',
            isPublished
              ? 'bg-zinc-700 text-zinc-300 hover:bg-zinc-600'
              : 'bg-emerald-700 text-white hover:bg-emerald-600',
          )}
          title={!loadedScriptId ? '请先保存剧本' : isPublished ? '取消发布' : '发布到首页'}
        >
          {publishing ? '...' : isPublished ? '已发布' : '发布'}
        </button>
      </div>
    </header>
  );
}
