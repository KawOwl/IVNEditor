/**
 * Auth Routes — 管理员认证
 *
 * POST /api/auth/login  — 登录，返回 token
 * GET  /api/auth/me     — 验证 token，返回用户信息
 */

import { Elysia } from 'elysia';
import { login, extractAdmin } from '../auth';

export const authRoutes = new Elysia({ prefix: '/api/auth' })

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

  .get('/me', async ({ request }) => {
    const username = await extractAdmin(request);
    if (!username) {
      return new Response(JSON.stringify({ error: '未登录或 token 已过期' }), { status: 401 });
    }
    return { ok: true, username };
  });
