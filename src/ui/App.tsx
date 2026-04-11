/**
 * App — 应用根组件（路由分发器）
 *
 * 三个页面：
 *   - home: 首页卡片网格
 *   - play: 对话页（互动叙事）
 *   - editor: 编辑器（需管理员登录）
 *
 * 路由通过 Zustand app-store 管理，不引入 React Router。
 *
 * 运行模式：
 *   - local: 首页从 IndexedDB 读取 published 剧本，PlayPage 在浏览器内运行引擎
 *   - remote: 首页从后端 API 读取 catalog，PlayPage 通过 WebSocket 连接后端引擎
 */

import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '../stores/app-store';
import { useAuthStore } from '../stores/auth-store';
import { ensureSessionId, fetchWithAuth } from '../stores/player-session-store';
import { HomePage } from './home/HomePage';
import { PlayPage } from './play/PlayPage';
import { EditorPage } from './editor/EditorPage';
import { LoginModal } from './auth/LoginModal';
import { ScriptStorage } from '../storage/script-storage';
import { getEngineMode, getBackendUrl } from '../core/engine-mode';
import type { ScriptManifest } from '../core/types';

const scriptStorage = new ScriptStorage();
const engineMode = getEngineMode();

/** 后端返回的公开剧本信息（脱敏，不含 prompt segments） */
interface PublicScriptInfo {
  id: string;
  label: string;
  description?: string;
  coverImage?: string;
  author?: string;
  tags?: string[];
  chapterCount: number;
  firstChapterId: string | null;
  openingMessages?: string[];
}

/**
 * 从公开信息构造一个 "pseudo manifest"，供 remote 模式的 PlayPage/PlayPanel 使用。
 * 内部字段（segments/stateSchema/memoryConfig）在 remote 模式下根本用不到，stub 即可。
 */
function publicInfoToManifest(info: PublicScriptInfo): ScriptManifest {
  return {
    id: info.id,
    label: info.label,
    coverImage: info.coverImage,
    description: info.description,
    author: info.author,
    tags: info.tags,
    openingMessages: info.openingMessages,
    chapters: [{
      id: info.firstChapterId ?? 'ch1',
      label: info.label,
      segments: [],
      flowGraph: { id: 'stub', label: 'stub', nodes: [], edges: [] },
    }],
    stateSchema: { variables: [] },
    memoryConfig: {
      contextBudget: 0,
      compressionThreshold: 0,
      recencyWindow: 0,
    },
    enabledTools: [],
  };
}

export function App() {
  const page = useAppStore((s) => s.page);
  const setCatalog = useAppStore((s) => s.setCatalog);
  const checkToken = useAuthStore((s) => s.checkToken);
  const isAdmin = useAuthStore((s) => s.isAdmin);
  const [showLogin, setShowLogin] = useState(false);
  const [authReady, setAuthReady] = useState(engineMode === 'local');
  const [authError, setAuthError] = useState<string | null>(null);

  // 启动时：初始化 player session（匿名身份）+ 验证 admin token
  useEffect(() => {
    if (engineMode !== 'remote') return;
    ensureSessionId()
      .then(() => setAuthReady(true))
      .catch((e) => {
        console.error('[Auth] Failed to init player session:', e);
        setAuthError(String(e));
      });
    checkToken();
  }, [checkToken]);

  // 全局快捷键 Ctrl+Shift+L 呼出管理员登录弹窗
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'L') {
      e.preventDefault();
      if (engineMode === 'remote' && !useAuthStore.getState().isAdmin) {
        setShowLogin(true);
      }
    }
  }, []);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Refresh published catalog when navigating to home
  const pageName = page.name;
  useEffect(() => {
    if (pageName !== 'home') return;

    if (engineMode === 'remote') {
      if (!authReady) return; // 等 player session 初始化完成
      // Remote mode: fetch catalog from backend API（需 playerAuth）
      fetchWithAuth(`${getBackendUrl()}/api/scripts/catalog`)
        .then((res) => res.json())
        .then((scripts: Array<{ id: string; label: string; description?: string; tags?: string[]; version?: string; chapterCount?: number }>) => {
          setCatalog(scripts.map((s) => ({
            id: s.id,
            label: s.label,
            description: s.description,
            tags: s.tags,
            version: s.version,
            chapterCount: s.chapterCount ?? 1,
          })));
        })
        .catch(() => {
          setCatalog([]);
        });
    } else {
      // Local mode: fetch from IndexedDB
      scriptStorage.listPublished().then((list) => {
        setCatalog(list.map((item) => ({
          id: item.id,
          label: item.label,
          description: item.description,
          tags: item.tags,
          chapterCount: item.fileCount,
        })));
      });
    }
  }, [setCatalog, pageName, authReady]);

  // 远程模式下，等 player session 初始化后才渲染主内容
  if (engineMode === 'remote' && !authReady) {
    return (
      <div className="h-full bg-zinc-950 text-zinc-100 flex items-center justify-center">
        <div className="text-center">
          {authError ? (
            <>
              <p className="text-red-400 mb-2">初始化失败</p>
              <p className="text-xs text-zinc-500 mb-4">{authError}</p>
              <button
                onClick={() => window.location.reload()}
                className="text-sm text-blue-400 hover:text-blue-300"
              >
                重新加载
              </button>
            </>
          ) : (
            <p className="text-zinc-500 text-sm">正在初始化...</p>
          )}
        </div>
      </div>
    );
  }

  let content: React.ReactNode;
  switch (page.name) {
    case 'home':
      content = <HomePage />;
      break;
    case 'play':
      content = <PlayPageLoader scriptId={page.scriptId} />;
      break;
    case 'editor':
      // Local 模式不需要认证；Remote 模式需要管理员登录
      if (engineMode === 'remote' && !isAdmin) {
        useAppStore.getState().goHome();
        return null;
      }
      content = <EditorPage />;
      break;
  }

  return (
    <>
      {content}
      {showLogin && <LoginModal onClose={() => setShowLogin(false)} />}
    </>
  );
}

/** Async loader: fetch manifest then render PlayPage */
function PlayPageLoader({ scriptId }: { scriptId: string }) {
  const [manifest, setManifest] = useState<ScriptManifest | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (engineMode === 'remote') {
      // Remote mode: fetch public script info（脱敏，不含 segments）
      fetchWithAuth(`${getBackendUrl()}/api/scripts/${scriptId}`)
        .then((res) => {
          if (!res.ok) throw new Error('Not found');
          return res.json();
        })
        .then((info: PublicScriptInfo) => setManifest(publicInfoToManifest(info)))
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
      <div className="h-full bg-zinc-950 text-zinc-100 flex items-center justify-center">
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
      <div className="h-full bg-zinc-950 text-zinc-100 flex items-center justify-center">
        <p className="text-zinc-500 text-sm">加载中...</p>
      </div>
    );
  }

  return <PlayPage manifest={manifest} scriptId={scriptId} />;
}

export { App as default };
