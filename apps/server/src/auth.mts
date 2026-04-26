/**
 * Auth — 统一的用户名/密码登录（6.2b 合并 admin + player）
 *
 * 和 6.2b 之前的版本不同：
 * - 不再硬编码 admin 用户列表，也不再用 HMAC self-contained token
 * - 所有用户（admin、注册玩家）都从 users 表读，靠 role_id 区分权限
 * - 登录成功产出 user_sessions 行，客户端拿 sessionId 作为 token
 *   （和匿名玩家用同一套 token 格式）
 * - 密码用 bcrypt 哈希存在 users.password_hash
 *
 * admin 用户通过 seed 脚本 `bun run seed:admin` 从 env 变量上架，
 * 详见 scripts/seed-admin.mts。
 */

import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { eq, or, sql } from 'drizzle-orm';
import { db, schema } from '#internal/db';

/** 登录返回体 */
export interface LoginResult {
  sessionId: string;
  userId: string;
  username: string | null;
  email: string | null;
  displayName: string | null;
  roleId: string;
  isAdmin: boolean;
}

/** 匿名 session 默认 1 年 */
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * 验证 identifier（email 或 username）+ 密码，成功则返回一个新的 session。
 * 失败（用户不存在 / 密码错 / 密码 hash 为空）都返回 null。
 *
 * PFB.3 起 identifier 字段同时匹配 email 和 username —— 兼容 PFB.2 引入
 * 的 email 注册流（用户没有 username）+ 既有 admin（用 username + bcrypt
 * password seed）。`email = identifier OR username = identifier` 一句 SQL
 * 解决，DB 层 unique 约束保证不会撞行。
 */
export async function login(
  identifier: string,
  password: string,
): Promise<LoginResult | null> {
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  // email 比对走 lowercase（注册时也 toLowerCase 入库）；username 大小写敏感不变
  const emailNormalized = trimmed.toLowerCase();

  const rows = await db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      email: schema.users.email,
      passwordHash: schema.users.passwordHash,
      displayName: schema.users.displayName,
      roleId: schema.users.roleId,
    })
    .from(schema.users)
    .where(
      or(
        eq(schema.users.email, emailNormalized),
        eq(schema.users.username, trimmed),
      ),
    )
    .limit(1);

  const user = rows[0];
  if (!user || !user.passwordHash) return null;

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return null;

  // 创建新 session
  const sessionId = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(schema.userSessions).values({
    id: sessionId,
    userId: user.id,
    expiresAt,
  });

  // 更新 last_seen_at（非关键，失败忽略）
  try {
    await db
      .update(schema.users)
      .set({ lastSeenAt: sql`NOW()` })
      .where(eq(schema.users.id, user.id));
  } catch {
    // ignore
  }

  return {
    sessionId,
    userId: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName,
    roleId: user.roleId,
    isAdmin: user.roleId === 'admin',
  };
}
