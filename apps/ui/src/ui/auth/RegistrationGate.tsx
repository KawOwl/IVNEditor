/**
 * RegistrationGate — 全局注册拦截 modal（PFB.2）
 *
 * 应用入口顶层挂这个组件。useAuthStore.kind === 'anonymous' 时全屏拦截
 * 用户，必须填完邮箱+密码+6 题画像才能进入网页。注册成功 → checkMe 把
 * kind 升到 'registered' → 该 modal 自然 unmount，不再阻塞。
 *
 * checking=true 期间不显示（避免 ensureSessionId+/api/auth/me 还在路上时
 * 闪一下 modal）。registered/admin 也不显示。
 */

import { useAuthStore } from '@/stores/auth-store';
import { RegisterForm } from './RegisterForm';

export function RegistrationGate() {
  const kind = useAuthStore((s) => s.kind);
  const checking = useAuthStore((s) => s.checking);

  if (checking) return null;
  if (kind !== 'anonymous') return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded shadow-2xl">
        <RegisterForm />
      </div>
    </div>
  );
}
