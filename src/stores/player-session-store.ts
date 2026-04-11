/**
 * Player Session Store — 客户端匿名身份管理
 *
 * 方案 4 的客户端侧：
 *   - 首次访问 → POST /api/auth/init → 拿 sessionId → 存 localStorage
 *   - 后续启动 → 读 localStorage → 验证 token → 用或重建
 *   - 所有 API 请求通过 fetchWithAuth 自动注入 Authorization header
 *
 * sessionId 从玩家视角是 opaque 的——只是一个标识，不携带任何 user 信息。
 * 服务端拿 sessionId 在 user_sessions 表查到 user_id。
 */

import { getBackendUrl } from '../core/engine-mode';

const LS_SESSION_ID_KEY = 'ivn-session-id';

// ============================================================================
// State
// ============================================================================

let cachedSessionId: string | null = null;
/** 正在进行的 init 请求（避免重复）*/
let ensurePromise: Promise<string> | null = null;

// ============================================================================
// Public API
// ============================================================================

/**
 * 确保客户端有一个可用的 sessionId。
 * - 首次调用：若 localStorage 有且服务端认可 → 复用；否则调 /auth/init 创建新的
 * - 后续调用：直接返回缓存的 sessionId
 * - 并发调用安全：同一 promise 被 dedupe
 */
export async function ensureSessionId(): Promise<string> {
  if (cachedSessionId) return cachedSessionId;
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    try {
      const stored = localStorage.getItem(LS_SESSION_ID_KEY);
      if (stored) {
        // 验证现有 token
        const res = await fetch(`${getBackendUrl()}/api/auth/me`, {
          headers: { Authorization: `Bearer ${stored}` },
        });
        if (res.ok) {
          cachedSessionId = stored;
          return stored;
        }
        // 401 或其他失败 → 清掉重建
        localStorage.removeItem(LS_SESSION_ID_KEY);
      }

      // 创建新的匿名 session
      const res = await fetch(`${getBackendUrl()}/api/auth/init`, {
        method: 'POST',
      });
      if (!res.ok) {
        throw new Error(`Failed to init session: ${res.status}`);
      }
      const data = await res.json();
      if (!data.sessionId) {
        throw new Error('Invalid /auth/init response');
      }
      localStorage.setItem(LS_SESSION_ID_KEY, data.sessionId);
      cachedSessionId = data.sessionId;
      return data.sessionId as string;
    } finally {
      ensurePromise = null;
    }
  })();

  return ensurePromise;
}

/**
 * 同步获取当前缓存的 sessionId（未初始化时返回 null）
 * 用于同步场景（比如 WS URL 构造）。
 * 调用前应确保已经 ensureSessionId。
 */
export function getSessionIdSync(): string | null {
  return cachedSessionId;
}

/**
 * 清除当前 session（登出、重置等场景）
 */
export function clearSessionId(): void {
  cachedSessionId = null;
  localStorage.removeItem(LS_SESSION_ID_KEY);
}

/**
 * 手动切换 sessionId（用于 login 成功后把匿名 session 换成
 * 登录用户的 session）。同步写 localStorage + 内存缓存，下次
 * fetchWithAuth 立即用新的。
 */
export function setSessionId(newSessionId: string): void {
  localStorage.setItem(LS_SESSION_ID_KEY, newSessionId);
  cachedSessionId = newSessionId;
  ensurePromise = null;
}

/**
 * 封装 fetch：自动注入 Authorization header，自动 ensure session
 * 用于所有 playerAuth 保护的 endpoint。
 *
 * 如果服务端返回 401（sessionId 已失效），自动清理并重试一次。
 */
export async function fetchWithAuth(url: string, init: RequestInit = {}): Promise<Response> {
  const sessionId = await ensureSessionId();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${sessionId}`);

  const res = await fetch(url, { ...init, headers });

  if (res.status !== 401) return res;

  // 401 → 当前 sessionId 失效，重建一次
  clearSessionId();
  const newSessionId = await ensureSessionId();
  const headers2 = new Headers(init.headers);
  headers2.set('Authorization', `Bearer ${newSessionId}`);
  return fetch(url, { ...init, headers: headers2 });
}
