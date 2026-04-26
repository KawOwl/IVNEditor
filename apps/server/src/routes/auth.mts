/**
 * Auth Routes
 *
 * 统一的 user_sessions 认证（6.2b 起）：
 *   POST /api/auth/init      — 创建匿名用户 + session
 *   POST /api/auth/register  — 升级当前匿名用户为注册用户（PFB.2，邮箱+密码+6 题画像）
 *   POST /api/auth/login     — 用户名/密码登录（admin + 注册玩家都走这条）
 *   POST /api/auth/logout    — 销毁当前 session
 *   GET  /api/auth/me        — 返回当前身份（含 isAdmin）
 *
 * admin 通过 seed 脚本从 env 上架到 users 表（role_id='admin'），
 * 登录后拿到的 sessionId 和匿名玩家一样。区别只在 /me 返回的 isAdmin 标志。
 */

import { Elysia } from 'elysia';
import bcrypt from 'bcryptjs';
import { z } from 'zod/v4';
import { login } from '#internal/auth';
import { resolveIdentity, resolvePlayerSession } from '#internal/auth-identity';
import { userService } from '#internal/services/user-service';

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
  // POST /register — 升级当前匿名用户为注册用户（PFB.2）
  //
  // 必须当前是 anonymous 身份（password_hash IS NULL）。把 email +
  // bcrypt(password) 写进 users 行 + insert user_profiles。同 sessionId
  // 继续生效（同一行 user 升级），客户端 checkMe() 后 kind 自然 anonymous → registered。
  // ============================================================================
  .post('/register', async ({ body, request }) => {
    const identity = await resolveIdentity(request);
    if (!identity) {
      return new Response(JSON.stringify({ error: '未登录或 token 已过期' }), { status: 401 });
    }
    if (identity.kind !== 'anonymous') {
      return new Response(
        JSON.stringify({ error: '当前用户已注册，无需再次注册' }),
        { status: 400 },
      );
    }

    const parsed = registerInputSchema.safeParse(body);
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: 'Invalid register payload', issues: parsed.error.issues }),
        { status: 400 },
      );
    }
    const input = parsed.data;

    const passwordHash = await bcrypt.hash(input.password, 10);
    const result = await userService.upgradeAnonymousToRegistered({
      userId: identity.userId,
      email: input.email,
      passwordHash,
      profile: {
        affiliation: input.profile.affiliation.trim(),
        gender: input.profile.gender,
        grade: input.profile.grade,
        major: input.profile.major,
        monthlyBudget: input.profile.monthlyBudget,
        hobbies: input.profile.hobbies,
      },
    });

    if (!result.ok) {
      if (result.reason === 'email-taken') {
        return new Response(
          JSON.stringify({ error: '邮箱已被注册', reason: 'email-taken' }),
          { status: 409 },
        );
      }
      // not-anonymous：identity 检查跟 service 之间有 race（两个并发 register）
      return new Response(
        JSON.stringify({ error: '当前用户已注册，无需再次注册', reason: result.reason }),
        { status: 400 },
      );
    }

    return {
      ok: true,
      kind: 'registered' as const,
      userId: identity.userId,
      email: input.email,
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
      email: identity.email,
      displayName: identity.displayName,
      roleId: identity.roleId,
      isAdmin: identity.kind === 'admin',
    };
  });

// 仅用于内部：从 WS query 参数解析 player session（WS 没法带 Authorization header）
export { resolvePlayerSession };

// ============================================================================
// PFB.2 注册问卷选项常量 + zod 校验
//
// 选项原文（中文）作为 enum 同时定义在前端 RegisterForm，靠后端 zod 严格
// 校验防漂移；前后端文案改时必须同步发布。
// ============================================================================

const GENDER_OPTIONS = ['男生', '女生'] as const;
const GRADE_OPTIONS = ['大一/大二', '大三/大四', '研究生及以上'] as const;
const MAJOR_OPTIONS = [
  '文史哲 / 外语 / 传媒类',
  '计算机 / 理工科类',
  '艺术 / 设计 / 影视类',
  '经管 / 法学 / 其他类',
] as const;
const MONTHLY_BUDGET_OPTIONS = [
  '100元以内',
  '100元 - 300元',
  '300元 - 500元',
  '500元以上',
] as const;
const HOBBY_OPTIONS = [
  '阅读长篇文字',
  '参与线下社交推演',
  '混迹二次元/泛娱乐社区',
  '刷短视频/追剧',
  '玩游戏大作',
] as const;

const AFFILIATION_MAX_LEN = 200;
const PASSWORD_MIN_LEN = 8;

const registerInputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(PASSWORD_MIN_LEN).max(128),
  profile: z.object({
    affiliation: z.string().trim().min(1).max(AFFILIATION_MAX_LEN),
    gender: z.enum(GENDER_OPTIONS),
    grade: z.enum(GRADE_OPTIONS),
    major: z.enum(MAJOR_OPTIONS),
    monthlyBudget: z.enum(MONTHLY_BUDGET_OPTIONS),
    hobbies: z
      .array(z.enum(HOBBY_OPTIONS))
      .min(1)
      .max(2)
      .refine((arr) => new Set(arr).size === arr.length, { message: 'hobbies must be unique' }),
  }),
});

// 公开选项常量给前端复用
export const PROFILE_OPTIONS = {
  gender: GENDER_OPTIONS,
  grade: GRADE_OPTIONS,
  major: MAJOR_OPTIONS,
  monthlyBudget: MONTHLY_BUDGET_OPTIONS,
  hobbies: HOBBY_OPTIONS,
} as const;
