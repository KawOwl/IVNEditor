/**
 * LoginModal — 管理员登录弹窗
 *
 * 简单的用户名 + 密码登录，成功后关闭并回调。
 */

import { useState, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth-store';

export function LoginModal({ onClose }: { onClose: () => void }) {
  const login = useAuthStore((s) => s.login);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) return;
    setLoading(true);
    setError('');
    const result = await login(username, password);
    setLoading(false);
    if (result.ok) {
      onClose();
    } else {
      setError(result.error ?? '登录失败');
    }
  }, [username, password, login, onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <form
        onSubmit={handleSubmit}
        className="w-80 bg-zinc-900 border border-zinc-700 rounded p-5 space-y-4 shadow-2xl"
      >
        <h2 className="text-sm font-medium text-zinc-200 text-center">管理员登录</h2>

        <div className="space-y-2">
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="用户名"
            autoFocus
            className="w-full text-xs px-3 py-2 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-500"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="密码"
            className="w-full text-xs px-3 py-2 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-500"
          />
        </div>

        {error && (
          <p className="text-[11px] text-red-400 text-center">{error}</p>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 text-xs px-3 py-2 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500 transition-colors"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={loading || !username || !password}
            className="flex-1 text-xs px-3 py-2 rounded bg-emerald-700 text-white hover:bg-emerald-600 disabled:opacity-50 transition-colors"
          >
            {loading ? '...' : '登录'}
          </button>
        </div>
      </form>
    </div>
  );
}
