/**
 * LoginModal — admin 全局快捷键登录弹窗（Ctrl+Shift+L 触发，App.tsx 注册）
 *
 * PFB.3 起 form 部分抽到 LoginForm 子组件，跟 RegistrationGate 共享。
 * 这里只负责 backdrop + modal 容器 + 关闭逻辑。
 */

import { LoginForm } from './LoginForm';

export function LoginModal({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md max-h-[80vh] flex flex-col bg-zinc-900 border border-zinc-700 rounded shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <LoginForm onSuccess={onClose} />
      </div>
    </div>
  );
}
