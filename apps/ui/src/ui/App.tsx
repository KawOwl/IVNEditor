/**
 * App — 应用根组件（路由分发器）
 *
 * 三个页面：
 *   - home: 首页卡片网格
 *   - play: 对话页（互动叙事）
 *   - editor: 编辑器（需管理员登录）
 *
 * 路由通过 Zustand app-store 管理，不引入 React Router。
 * 6.6 后仅支持 remote 模式——所有剧本/游玩数据都走后端 API。
 */

import { useCallback, useEffect, useState } from 'react';
import { useAppStore } from '#internal/stores/app-store';
import { useAuthStore } from '#internal/stores/auth-store';
import { ensureSessionId, fetchWithAuth } from '#internal/stores/player-session-store';
import { HomePage } from '#internal/ui/home/HomePage';
import { PlayPage } from '#internal/ui/play/PlayPage';
import { EditorPage } from '#internal/ui/editor/EditorPage';
import { LoginModal } from '#internal/ui/auth/LoginModal';
import {
  publicInfoToManifest,
  type PublicScriptInfo,
} from '#internal/ui/play/public-script-info';
import { getBackendUrl } from '@/lib/backend-url';
import type { ScriptManifest } from '@ivn/core/types';

export function App() {
  const page = useAppStore((s) => s.page);
  const setCatalog = useAppStore((s) => s.setCatalog);
  const checkMe = useAuthStore((s) => s.checkMe);
  const isAdmin = useAuthStore((s) => s.isAdmin);
  const [showLogin, setShowLogin] = useState(false);
  const [authReady, setAuthReady] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // 启动时：初始化 player session + checkMe 填充 auth store
  useEffect(() => {
    ensureSessionId()
      .then(() => checkMe())
      .then(() => setAuthReady(true))
      .catch((e) => {
        console.error('[Auth] Failed to init player session:', e);
        setAuthError(String(e));
      });
  }, [checkMe]);

  // 全局快捷键 Ctrl+Shift+L 呼出管理员登录弹窗
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'L') {
      e.preventDefault();
      if (!useAuthStore.getState().isAdmin) {
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
    if (!authReady) return;

    fetchWithAuth(`${getBackendUrl()}/api/scripts/catalog`)
      .then((res) => res.json())
      .then((scripts: Array<{
        id: string;
        label: string;
        description?: string;
        tags?: string[];
        version?: string;
        chapterCount?: number;
      }>) => {
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
  }, [setCatalog, pageName, authReady]);

  // 等 player session 初始化后才渲染主内容
  if (!authReady) {
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
      // 编辑器仅管理员可访问
      if (!isAdmin) {
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
    fetchWithAuth(`${getBackendUrl()}/api/scripts/${scriptId}`)
      .then((res) => {
        if (!res.ok) throw new Error('Not found');
        return res.json();
      })
      .then((info: PublicScriptInfo) => setManifest(publicInfoToManifest(info)))
      .catch(() => setError(true));
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
