/**
 * App — 应用根组件（路由分发器）
 *
 * 三个页面：
 *   - home: 首页卡片网格
 *   - play: 对话页（互动叙事）
 *   - editor: 编辑器
 *
 * 路由通过 Zustand app-store 管理，不引入 React Router。
 *
 * 运行模式：
 *   - local: 首页从 IndexedDB 读取 published 剧本，PlayPage 在浏览器内运行引擎
 *   - remote: 首页从后端 API 读取 catalog，PlayPage 通过 WebSocket 连接后端引擎
 */

import { useEffect, useState } from 'react';
import { useAppStore } from '../stores/app-store';
import { HomePage } from './home/HomePage';
import { PlayPage } from './play/PlayPage';
import { EditorPage } from './editor/EditorPage';
import { ScriptStorage } from '../storage/script-storage';
import { getEngineMode, getBackendUrl } from '../core/engine-mode';
import type { ScriptManifest } from '../core/types';

const scriptStorage = new ScriptStorage();
const engineMode = getEngineMode();

export function App() {
  const page = useAppStore((s) => s.page);
  const setCatalog = useAppStore((s) => s.setCatalog);

  // Refresh published catalog when navigating to home
  const pageName = page.name;
  useEffect(() => {
    if (pageName !== 'home') return;

    if (engineMode === 'remote') {
      // Remote mode: fetch catalog from backend API
      fetch(`${getBackendUrl()}/api/scripts/catalog`)
        .then((res) => res.json())
        .then((scripts: Array<{ id: string; label: string; description?: string; chapterCount?: number }>) => {
          setCatalog(scripts.map((s) => ({
            id: s.id,
            label: s.label,
            description: s.description,
            chapterCount: s.chapterCount ?? 1,
          })));
        })
        .catch(() => {
          // Silently fail — show empty catalog
          setCatalog([]);
        });
    } else {
      // Local mode: fetch from IndexedDB
      scriptStorage.listPublished().then((list) => {
        setCatalog(list.map((item) => ({
          id: item.id,
          label: item.label,
          description: item.description,
          chapterCount: item.fileCount,
        })));
      });
    }
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

/** Async loader: fetch manifest then render PlayPage */
function PlayPageLoader({ scriptId }: { scriptId: string }) {
  const [manifest, setManifest] = useState<ScriptManifest | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (engineMode === 'remote') {
      // Remote mode: fetch manifest from backend
      fetch(`${getBackendUrl()}/api/scripts/${scriptId}`)
        .then((res) => {
          if (!res.ok) throw new Error('Not found');
          return res.json();
        })
        .then((data) => setManifest(data.manifest))
        .catch(() => setError(true));
    } else {
      // Local mode: fetch from IndexedDB
      scriptStorage.get(scriptId).then((record) => {
        if (record) {
          setManifest(record.manifest);
        } else {
          setError(true);
        }
      });
    }
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

  return <PlayPage manifest={manifest} scriptId={scriptId} />;
}

export { App as default };
