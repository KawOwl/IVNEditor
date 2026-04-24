/**
 * Auth Routes
 *
 * 统一的 user_sessions 认证（6.2b 起）：
 *   POST /api/auth/init    — 创建匿名用户 + session
 *   POST /api/auth/login   — 用户名/密码登录（admin + 注册玩家都走这条）
 *   POST /api/auth/logout  — 销毁当前 session
 *   GET  /api/auth/me      — 返回当前身份（含 isAdmin）
 *
 * admin 通过 seed 脚本从 env 上架到 users 表（role_id='admin'），
 * 登录后拿到的 sessionId 和匿名玩家一样。区别只在 /me 返回的 isAdmin 标志。
 */

import { Elysia } from 'elysia';
import { login } from '../auth';
import { resolveIdentity, resolvePlayerSession } from '#server/auth-identity';
import { userService } from '#server/services/user-service';

export const authRoutes = new Elysia({ prefix: '/api/auth' })

  // ============================================================================
  // POST /login — 用户名/密码登录
  // ============================================================================
  .post('/login', async ({ body }) => {
    const { username, password } = body as { username: string; password: string };
    if (!username || !password) {
      return new Response(JSON.stringify({ error: '请输入用户名和密码' }), { status: 400 });
    }

    const result = await login(username, password);
    if (!result) {
      return new Response(JSON.stringify({ error: '用户名或密码错误' }), { status: 401 });
    }

    return {
      ok: true,
      sessionId: result.sessionId,
      userId: result.userId,
      username: result.username,
      displayName: result.displayName,
      roleId: result.roleId,
      isAdmin: result.isAdmin,
    };
  })

  // ============================================================================
  // POST /init — 创建匿名玩家 session
  // ============================================================================
  .post('/init', async () => {
    const { sessionId, expiresAt } = await userService.createAnonymous();
    return {
      ok: true,
      sessionId,
      expiresAt: expiresAt.toISOString(),
    };
  })

  // ============================================================================
  // POST /logout — 销毁当前 session
  // ============================================================================
  .post('/logout', async ({ request }) => {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'No token' }), { status: 401 });
    }
    const token = authHeader.slice(7).trim();
    const deleted = await userService.deleteSession(token);
    return { ok: deleted };
  })

  // ============================================================================
  // GET /me — 当前身份
  // ============================================================================
  .get('/me', async ({ request }) => {
    const identity = await resolveIdentity(request);
    if (!identity) {
      return new Response(JSON.stringify({ error: '未登录或 token 已过期' }), { status: 401 });
    }

    return {
      ok: true,
      kind: identity.kind,             // 'anonymous' | 'registered' | 'admin'
      userId: identity.userId,
      username: identity.username,
      displayName: identity.displayName,
      roleId: identity.roleId,
      isAdmin: identity.kind === 'admin',
    };
  });

// 仅用于内部：从 WS query 参数解析 player session（WS 没法带 Authorization header）
export { resolvePlayerSession };
