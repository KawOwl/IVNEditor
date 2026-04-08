/**
 * Auth Routes
 *
 * 管理员（编辑器）:
 *   POST /api/auth/login   — 登录
 *
 * 玩家（匿名 + 未来注册）:
 *   POST /api/auth/init    — 创建匿名用户 + session（无需任何凭证）
 *   POST /api/auth/logout  — 销毁当前 session
 *
 * 通用:
 *   GET  /api/auth/me      — 返回当前身份（根据 token 自动识别 admin / player）
 *
 * 注意：/api/auth/login 当前只服务 admin。未来做玩家登录时在这里补。
 */

import { Elysia } from 'elysia';
import { login } from '../auth';
import { resolveIdentity, resolvePlayerSession } from '../auth-identity';
import { userService } from '../services/user-service';

export const authRoutes = new Elysia({ prefix: '/api/auth' })

  // ============================================================================
  // POST /login — 管理员登录（保留原有行为）
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
      token: result.token,
      username: result.username,
      displayName: result.displayName,
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
  // POST /logout — 销毁当前 player session
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
  // GET /me — 当前身份（admin 或 player 都支持）
  // ============================================================================
  .get('/me', async ({ request }) => {
    const identity = await resolveIdentity(request);
    if (!identity) {
      return new Response(JSON.stringify({ error: '未登录或 token 已过期' }), { status: 401 });
    }

    // admin 响应：保持向后兼容（username 字段）
    if (identity.kind === 'admin') {
      return {
        ok: true,
        kind: 'admin',
        username: identity.adminUsername,
      };
    }

    // player 响应
    return {
      ok: true,
      kind: identity.kind, // 'anonymous' | 'registered'
      userId: identity.userId,
      isRegistered: identity.isRegistered,
      username: identity.playerUsername ?? null,
    };
  });

// 仅用于内部：从 WS query 参数解析 player session（WS 没法带 Authorization header）
export { resolvePlayerSession };
