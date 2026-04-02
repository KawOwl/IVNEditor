/**
 * AuthStore — 管理员认证状态
 *
 * token 存储在 localStorage，页面刷新后自动恢复。
 * 提供 login / logout / isAdmin 判断。
 */

import { create } from 'zustand';
import { getBackendUrl } from '../core/engine-mode';

// ============================================================================
// Types
// ============================================================================

interface AuthState {
  token: string | null;
  username: string | null;
  /** 是否已通过管理员认证 */
  isAdmin: boolean;
  /** 正在验证 token */
  checking: boolean;

  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => void;
  /** 启动时验证已存储的 token */
  checkToken: () => Promise<void>;
  /** 获取 Authorization header */
  getAuthHeader: () => Record<string, string>;
}

// ============================================================================
// LocalStorage keys
// ============================================================================

const LS_TOKEN = 'ivn-admin-token';
const LS_USERNAME = 'ivn-admin-username';

// ============================================================================
// Store
// ============================================================================

export const useAuthStore = create<AuthState>((set, get) => ({
  token: localStorage.getItem(LS_TOKEN),
  username: localStorage.getItem(LS_USERNAME),
  isAdmin: false,
  checking: true,

  login: async (username, password) => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { ok: false, error: data.error ?? '登录失败' };
      }
      localStorage.setItem(LS_TOKEN, data.token);
      localStorage.setItem(LS_USERNAME, data.username);
      set({ token: data.token, username: data.username, isAdmin: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: '网络错误' };
    }
  },

  logout: () => {
    localStorage.removeItem(LS_TOKEN);
    localStorage.removeItem(LS_USERNAME);
    set({ token: null, username: null, isAdmin: false });
  },

  checkToken: async () => {
    const token = get().token;
    if (!token) {
      set({ isAdmin: false, checking: false });
      return;
    }
    try {
      const res = await fetch(`${getBackendUrl()}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        set({ isAdmin: true, username: data.username, checking: false });
      } else {
        // Token 无效或过期
        localStorage.removeItem(LS_TOKEN);
        localStorage.removeItem(LS_USERNAME);
        set({ token: null, username: null, isAdmin: false, checking: false });
      }
    } catch {
      // 网络错误时保留 token 但不标记为 admin
      set({ isAdmin: false, checking: false });
    }
  },

  getAuthHeader: (): Record<string, string> => {
    const token = get().token;
    if (token) return { Authorization: `Bearer ${token}` };
    return {};
  },
}));
