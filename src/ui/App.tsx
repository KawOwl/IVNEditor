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

import { useEffect, useState } from 'react';
import { useAppStore } from '../stores/app-store';
import { HomePage } from './home/HomePage';
import { PlayPage } from './play/PlayPage';
import { EditorPage } from './editor/EditorPage';
import { ScriptStorage } from '../storage/script-storage';
import type { ScriptManifest } from '../core/types';

const scriptStorage = new ScriptStorage();

export function App() {
  const page = useAppStore((s) => s.page);
  const setCatalog = useAppStore((s) => s.setCatalog);

  // Refresh published catalog when navigating to home
  const pageName = page.name;
  useEffect(() => {
    if (pageName !== 'home') return;
    scriptStorage.listPublished().then((list) => {
      setCatalog(list.map((item) => ({
        id: item.id,
        label: item.label,
        description: item.description,
        chapterCount: item.fileCount,
      })));
    });
  }, [setCatalog, pageName]);

  switch (page.name) {
    case 'home':
      return <HomePage />;

    case 'play':
      return <PlayPageLoader scriptId={page.scriptId} />;

    case 'editor':
      return <EditorPage />;
  }
}

/** Async loader: fetch manifest from IndexedDB then render PlayPage */
function PlayPageLoader({ scriptId }: { scriptId: string }) {
  const [manifest, setManifest] = useState<ScriptManifest | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    scriptStorage.get(scriptId).then((record) => {
      if (record) {
        setManifest(record.manifest);
      } else {
        setError(true);
      }
    });
  }, [scriptId]);

  if (error) {
    return (
      <div className="h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center">
        <div className="text-center">
          <p className="text-zinc-400 mb-4">找不到剧本: {scriptId}</p>
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

  if (!manifest) {
    return (
      <div className="h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center">
        <p className="text-zinc-500 text-sm">加载中...</p>
      </div>
    );
  }

  return <PlayPage manifest={manifest} />;
}

export { App as default };
