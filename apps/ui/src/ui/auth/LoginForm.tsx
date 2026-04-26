/**
 * LoginForm — identifier (email 或 username) + 密码登录（PFB.3）
 *
 * 用作 RegistrationGate 的"登录" tab + LoginModal 内嵌（admin 全局快捷键
 * 触发）。只负责表单和提交，外层 modal/tab 负责关闭/切换。
 *
 * identifier 字段同时接受 email（PFB.2 注册的玩家）和 username（admin
 * seed 行）；后端 routes/auth.mts /login 同时按两个字段查。
 */

import { useCallback, useState } from 'react';
import { useAuthStore } from '@/stores/auth-store';
import { cn } from '@/lib/utils';

export function LoginForm({ onSuccess }: { onSuccess?: () => void }) {
  const login = useAuthStore((s) => s.login);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const canSubmit = !loading && identifier.trim().length > 0 && password.length > 0;

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setLoading(true);
    setError('');
    const result = await login(identifier.trim(), password);
    setLoading(false);
    if (result.ok) {
      onSuccess?.();
    } else {
      setError(result.error ?? '登录失败');
    }
  }, [canSubmit, identifier, password, login, onSuccess]);

  return (
    <form onSubmit={handleSubmit} className="flex-1 flex flex-col">
      <div className="flex-none px-5 py-4 border-b border-zinc-800">
        <h2 className="text-sm font-medium text-zinc-200">登录已注册账号</h2>
        <p className="text-[11px] text-zinc-500 mt-1">
          已经注册过的用户可以直接登录恢复账号；admin 用 username 登录。
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
        <fieldset className="space-y-1">
          <legend className="text-xs text-zinc-300">
            <span className="text-red-400 mr-1">*</span>邮箱 或 用户名
          </legend>
          <input
            type="text"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="you@example.com"
            disabled={loading}
            className="w-full px-3 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs focus:outline-none focus:border-emerald-600"
            autoFocus
          />
        </fieldset>

        <fieldset className="space-y-1">
          <legend className="text-xs text-zinc-300">
            <span className="text-red-400 mr-1">*</span>密码
          </legend>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            className="w-full px-3 py-1.5 rounded bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs focus:outline-none focus:border-emerald-600"
          />
        </fieldset>
      </div>

      <div className="flex-none px-5 py-3 border-t border-zinc-800 flex items-center gap-2">
        <span
          className={cn(
            'text-[11px] flex-1',
            error ? 'text-red-400' : 'text-zinc-500',
          )}
        >
          {error && error}
          {loading && !error && '登录中…'}
        </span>
        <button
          type="submit"
          disabled={!canSubmit}
          className="text-xs px-3 py-1.5 rounded bg-emerald-700 text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          登录
        </button>
      </div>
    </form>
  );
}
