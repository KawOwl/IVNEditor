/**
 * HomePage — 首页
 *
 * 展示小说/剧本卡片网格，点击进入对话页。
 */

import { useAppStore } from '../../stores/app-store';
import { ScriptCard } from './ScriptCard';

export function HomePage() {
  const catalog = useAppStore((s) => s.catalog);
  const navigateTo = useAppStore((s) => s.navigateTo);

  return (
    <div className="h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      {/* Header */}
      <header className="flex-none px-8 py-5 border-b border-zinc-800">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-zinc-100">
              Interactive Novel Engine
            </h1>
            <p className="text-xs text-zinc-500 mt-0.5">
              互动视觉小说引擎 v2.0
            </p>
          </div>
          <button
            onClick={() => navigateTo({ name: 'editor' })}
            className="text-xs px-3 py-1.5 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors"
          >
            编辑器
          </button>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-6xl mx-auto px-8 py-8">
          {/* Section title */}
          <div className="mb-6">
            <h2 className="text-sm font-medium text-zinc-400">全部作品</h2>
          </div>

          {catalog.length === 0 ? (
            <EmptyState onGoEditor={() => navigateTo({ name: 'editor' })} />
          ) : (
            /* Card grid */
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {catalog.map((entry) => (
                <ScriptCard
                  key={entry.id}
                  entry={entry}
                  onClick={() => navigateTo({ name: 'play', scriptId: entry.id })}
                />
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function EmptyState({ onGoEditor }: { onGoEditor: () => void }) {
  return (
    <div className="text-center py-20">
      <div className="text-4xl mb-4 text-zinc-700">
        &empty;
      </div>
      <h3 className="text-zinc-400 mb-2">还没有作品</h3>
      <p className="text-sm text-zinc-600 mb-6">
        创建你的第一个互动小说剧本
      </p>
      <button
        onClick={onGoEditor}
        className="text-sm px-4 py-2 rounded bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
      >
        打开编辑器
      </button>
    </div>
  );
}
