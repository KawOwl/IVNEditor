/**
 * App — 应用根组件（路由分发器）
 *
 * 三个页面：
 *   - home: 首页卡片网格
 *   - play: 对话页（互动叙事）
 *   - editor: 编辑器（待实现）
 *
 * 路由通过 Zustand app-store 管理，不引入 React Router。
 */

import { useEffect } from 'react';
import { useAppStore } from '../stores/app-store';
import { HomePage } from './home/HomePage';
import { PlayPage } from './play/PlayPage';
import { getCatalog, getManifestById } from '../fixtures/registry';

export function App() {
  const page = useAppStore((s) => s.page);
  const setCatalog = useAppStore((s) => s.setCatalog);

  // Load catalog on mount
  useEffect(() => {
    setCatalog(getCatalog());
  }, [setCatalog]);

  switch (page.name) {
    case 'home':
      return <HomePage />;

    case 'play': {
      const manifest = getManifestById(page.scriptId);
      if (!manifest) {
        return (
          <div className="h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center">
            <div className="text-center">
              <p className="text-zinc-400 mb-4">找不到剧本: {page.scriptId}</p>
              <button
                onClick={() => useAppStore.getState().goHome()}
                className="text-sm text-blue-400 hover:text-blue-300"
              >
                返回首页
              </button>
            </div>
          </div>
        );
      }
      return <PlayPage manifest={manifest} />;
    }

    case 'editor':
      return (
        <div className="h-screen bg-zinc-950 text-zinc-100 flex flex-col">
          <header className="flex-none px-8 py-5 border-b border-zinc-800">
            <div className="flex items-center gap-3">
              <button
                onClick={() => useAppStore.getState().goHome()}
                className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                ← 返回
              </button>
              <h1 className="text-sm font-medium text-zinc-300">编辑器</h1>
            </div>
          </header>
          <div className="flex-1 flex items-center justify-center text-zinc-600">
            编辑器功能开发中...
          </div>
        </div>
      );
  }
}

export { App as default };
