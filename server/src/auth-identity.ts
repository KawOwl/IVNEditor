/**
 * Identity Resolution — 统一的身份解析中间件
 *
 * 从 Authorization header 提取 sessionId token，查 user_sessions + users
 * 表，返回 Identity。6.2b 之后只有一种 token 类型：user_sessions.id (UUID)，
 * admin 和普通玩家用同一套 token 格式，区别只在 users.role_id。
 *
 * 调用方通常走 requireAdmin / requirePlayer / requireAnyIdentity 获取
 * 典型权限语义。
 */

import { eq, gt, and } from 'drizzle-orm';
import { db, schema } from './db';

// ============================================================================
// Types
// ============================================================================

/**
 * 'anonymous'  — users.username 为空（未登录、自动创建的匿名行）
 * 'registered' — 注册普通玩家（users.username 非空，role_id='user'）
 * 'admin'      — users.role_id='admin'
 */
export type IdentityKind = 'anonymous' | 'registered' | 'admin';

export interface Identity {
  kind: IdentityKind;
  /** users.id（UUID） */
  userId: string;
  /** 便捷字段：kind !== 'anonymous' */
  isRegistered: boolean;
  /** 用户名（anonymous 无） */
  username: string | null;
  /** users.role_id */
  roleId: string;
  /** 显示名（可能为空） */
  displayName: string | null;
}

// ============================================================================
// resolveIdentity — 统一身份解析
// ============================================================================

/**
 * 从 Request 的 Authorization header 解析身份。
 * 失败返回 null（没有 header / token 过期 / session 不存在）。
 */
export async function resolveIdentity(request: Request): Promise<Identity | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  return resolvePlayerSession(token);
}

/**
 * 从 sessionId 解析身份（WS 连接 query / Authorization header 都用这个）。
 */
export async function resolvePlayerSession(token: string): Promise<Identity | null> {
  if (!token) return null;

  const now = new Date();
  const rows = await db
    .select({
      userId: schema.userSessions.userId,
      username: schema.users.username,
      displayName: schema.users.displayName,
      roleId: schema.users.roleId,
    })
    .from(schema.userSessions)
    .innerJoin(schema.users, eq(schema.userSessions.userId, schema.users.id))
    .where(
      and(
        eq(schema.userSessions.id, token),
        gt(schema.userSessions.expiresAt, now),
      ),
    )
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0]!;

  // 滑动续期：更新 last_used_at + 延长 expires_at（fire-and-forget）
  const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
  const newExpiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.update(schema.userSessions)
    .set({ lastUsedAt: now, expiresAt: newExpiresAt })
    .where(eq(schema.userSessions.id, token))
    .catch(() => {});

  const kind: IdentityKind =
    row.roleId === 'admin'
      ? 'admin'
      : row.username !== null
        ? 'registered'
        : 'anonymous';

  return {
    kind,
    userId: row.userId,
    isRegistered: kind !== 'anonymous',
    username: row.username,
    roleId: row.roleId,
    displayName: row.displayName,
  };
}

// ============================================================================
// Route helpers
// ============================================================================

/** 要求 admin 身份 */
export async function requireAdmin(request: Request): Promise<Identity | Response> {
  const identity = await resolveIdentity(request);
  if (!identity || identity.kind !== 'admin') {
    return new Response(JSON.stringify({ error: 'Admin required' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return identity;
}

/**
 * 要求 player 身份：匿名或注册的普通玩家。
 *
 * admin 不算"玩家"——避免 admin 用同一套 session 去玩游戏时把 admin
 * 的 userId 污染到 playthroughs 上。
 */
export async function requirePlayer(request: Request): Promise<Identity | Response> {
  const identity = await resolveIdentity(request);
  if (!identity) {
    return new Response(JSON.stringify({ error: 'Authentication required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (identity.kind === 'admin') {
    return new Response(JSON.stringify({ error: 'Player identity required' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return identity;
}

/** 要求任意已认证身份（admin 或 player） */
export async function requireAnyIdentity(request: Request): Promise<Identity | Response> {
  const identity = await resolveIdentity(request);
  if (!identity) {
    return new Response(JSON.stringify({ error: 'Authentication required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return identity;
}

/** 判断是不是 Response（类型守卫） */
export function isResponse(v: unknown): v is Response {
  return v instanceof Response;
}
