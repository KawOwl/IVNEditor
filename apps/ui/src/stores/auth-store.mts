/**
 * AuthStore — 登录状态（admin + 注册玩家统一）
 *
 * 6.2b 起，admin 和普通玩家共用一套 user_sessions token（见
 * player-session-store 的 sessionId）。本 store 只管理"登录身份"的
 * UI 状态，真正的 token 存在 player-session-store 里。
 *
 * 流程：
 *   1. 应用启动时 ensureSessionId() 拿到当前 sessionId（可能是匿名）
 *   2. checkMe() 读 /api/auth/me 更新 isAdmin/username/displayName
 *   3. login(username, password) → 拿新 sessionId → setSessionId 覆盖 →
 *      update isAdmin/username 等本地状态
 *   4. logout() → clearSessionId → 重新 ensureSessionId 生成新匿名 →
 *      重置本地 isAdmin=false
 */

import { create } from 'zustand';
import { getBackendUrl } from '@/lib/backend-url';
import {
  ensureSessionId,
  setSessionId,
  clearSessionId,
  fetchWithAuth,
} from '#internal/stores/player-session-store';

// ============================================================================
// Types
// ============================================================================

interface LoginResponse {
  ok: boolean;
  sessionId: string;
  userId: string;
  username: string;
  displayName: string | null;
  roleId: string;
  isAdmin: boolean;
}

interface MeResponse {
  ok: boolean;
  kind: 'anonymous' | 'registered' | 'admin';
  userId: string;
  username: string | null;
  email: string | null;
  displayName: string | null;
  roleId: string;
  isAdmin: boolean;
}

export type IdentityKind = 'anonymous' | 'registered' | 'admin';

interface AuthState {
  /** 身份种类（PFB.2 起暴露给业务层做 register / feedback 路由） */
  kind: IdentityKind;
  /** 当前用户名（注册玩家可能为 null —— PFB.2 起注册主键是 email） */
  username: string | null;
  /** 注册邮箱（仅 registered 有值） */
  email: string | null;
  /** 是否 admin（roleId === 'admin'） */
  isAdmin: boolean;
  /** 正在校验 session */
  checking: boolean;

  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  /** 应用启动时调用，从当前 sessionId 读身份填充 store */
  checkMe: () => Promise<void>;
  /**
   * 获取 Authorization header（同步）
   * 用于必须直接用 fetch 而不走 fetchWithAuth 的场景。
   * 调用前必须先 ensureSessionId 或 checkMe。
   */
  getAuthHeader: () => Record<string, string>;
}

// ============================================================================
// Store
// ============================================================================

export const useAuthStore = create<AuthState>((set) => ({
  kind: 'anonymous',
  username: null,
  email: null,
  isAdmin: false,
  checking: true,

  login: async (username, password) => {
    try {
      const res = await fetch(`${getBackendUrl()}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = (await res.json()) as Partial<LoginResponse> & { error?: string };
      if (!res.ok || !data.sessionId) {
        return { ok: false, error: data.error ?? '登录失败' };
      }
      // 用新的 sessionId 覆盖当前（可能是匿名的）session
      setSessionId(data.sessionId);
      set({
        kind: data.isAdmin ? 'admin' : 'registered',
        username: data.username ?? null,
        email: null, // /login 不返回 email；checkMe 时再补
        isAdmin: data.isAdmin ?? false,
        checking: false,
      });
      return { ok: true };
    } catch {
      return { ok: false, error: '网络错误' };
    }
  },

  logout: async () => {
    // 调后端销毁 session（best-effort）
    try {
      await fetchWithAuth(`${getBackendUrl()}/api/auth/logout`, { method: 'POST' });
    } catch {
      // ignore
    }
    clearSessionId();
    set({ kind: 'anonymous', username: null, email: null, isAdmin: false, checking: false });
    // 立即重新 ensure 一个新的匿名 session，让后续请求能用
    try {
      await ensureSessionId();
    } catch {
      // ignore
    }
  },

  checkMe: async () => {
    try {
      await ensureSessionId();
      const res = await fetch(`${getBackendUrl()}/api/auth/me`, {
        headers: {
          // 显式从当前 session 拿 header（不走 fetchWithAuth，避免 401 重试循环）
          Authorization: `Bearer ${localStorage.getItem('ivn-session-id') ?? ''}`,
        },
      });
      if (res.ok) {
        const data = (await res.json()) as MeResponse;
        set({
          kind: data.kind,
          username: data.username,
          email: data.email,
          isAdmin: data.isAdmin,
          checking: false,
        });
      } else {
        set({ kind: 'anonymous', username: null, email: null, isAdmin: false, checking: false });
      }
    } catch {
      set({ kind: 'anonymous', username: null, email: null, isAdmin: false, checking: false });
    }
  },

  getAuthHeader: (): Record<string, string> => {
    const sessionId = localStorage.getItem('ivn-session-id');
    if (sessionId) return { Authorization: `Bearer ${sessionId}` };
    return {};
  },
}));
