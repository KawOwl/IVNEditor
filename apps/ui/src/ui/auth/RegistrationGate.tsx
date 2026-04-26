/**
 * RegistrationGate — 全局注册/登录拦截 modal（PFB.2 + PFB.3）
 *
 * 应用入口顶层挂这个组件。useAuthStore.kind === 'anonymous' 时全屏拦截
 * 用户。Modal 顶部有 tab：默认"注册"（RegisterForm 邮箱+密码+6 题画像）
 * / "登录"（LoginForm，已注册过的用户回来用 email 或 username 登录）。
 *
 * 注册成功 → checkMe 把 kind 升 'registered' → modal 自然 unmount。
 * 登录成功 → auth-store.login 内部 setSessionId + setKind → 同样 unmount。
 *
 * checking=true 期间不显示（避免 ensureSessionId+/api/auth/me 还在路上时
 * 闪一下 modal）。registered/admin 也不显示。
 */

import { useState } from 'react';
import { useAuthStore } from '@/stores/auth-store';
import { RegisterForm } from './RegisterForm';
import { LoginForm } from './LoginForm';
import { cn } from '@/lib/utils';

export function RegistrationGate() {
  const kind = useAuthStore((s) => s.kind);
  const checking = useAuthStore((s) => s.checking);
  const [tab, setTab] = useState<'register' | 'login'>('register');

  if (checking) return null;
  if (kind !== 'anonymous') return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded shadow-2xl">
        {/* Tab bar */}
        <div className="flex-none flex border-b border-zinc-800">
          <button
            type="button"
            onClick={() => setTab('register')}
            className={cn(
              'flex-1 px-4 py-2.5 text-xs font-medium transition-colors',
              tab === 'register'
                ? 'text-zinc-100 border-b-2 border-emerald-600'
                : 'text-zinc-500 hover:text-zinc-300',
            )}
          >
            注册
          </button>
          <button
            type="button"
            onClick={() => setTab('login')}
            className={cn(
              'flex-1 px-4 py-2.5 text-xs font-medium transition-colors',
              tab === 'login'
                ? 'text-zinc-100 border-b-2 border-emerald-600'
                : 'text-zinc-500 hover:text-zinc-300',
            )}
          >
            登录
          </button>
        </div>

        {tab === 'register' ? <RegisterForm /> : <LoginForm />}
      </div>
    </div>
  );
}
