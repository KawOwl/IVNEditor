/**
 * Identity Resolution — 统一的身份解析中间件
 *
 * 从 Authorization header 提取 token，判断 token 类型（admin / player），
 * 查到对应的 identity。所有需要 auth 的 route 都调这个函数。
 *
 * Token 类型判断：
 *   - admin token: "username:timestamp:signature"（3 段冒号分隔）
 *   - player token: UUID 格式（user_sessions.id，36 字符）
 */

import { eq, gt, and } from 'drizzle-orm';
import { db, schema } from './db';
import { verifyToken as verifyAdminToken } from './auth';

// ============================================================================
// Types
// ============================================================================

export type IdentityKind = 'anonymous' | 'registered' | 'admin';

export interface Identity {
  kind: IdentityKind;
  /**
   * 身份的稳定 ID：
   * - player (匿名/注册): users.id (uuid)
   * - admin: username
   */
  userId: string;
  /** 用于 player 区分匿名/注册；admin 视同 true */
  isRegistered: boolean;
  /** 仅 admin 有值 */
  adminUsername?: string;
  /** 仅 player 注册用户有值 */
  playerUsername?: string;
}

// ============================================================================
// Token 类型判断
// ============================================================================

/** admin token 形如 "username:timestamp:signature" */
function looksLikeAdminToken(token: string): boolean {
  const parts = token.split(':');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

// ============================================================================
// resolveIdentity — 统一身份解析
// ============================================================================

/**
 * 从 Request 解析身份。失败返回 null。
 */
export async function resolveIdentity(request: Request): Promise<Identity | null> {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;

  // 1. 先尝试 admin token
  if (looksLikeAdminToken(token)) {
    const username = await verifyAdminToken(token);
    if (username) {
      return {
        kind: 'admin',
        userId: username,
        isRegistered: true,
        adminUsername: username,
      };
    }
    // admin token 格式但验证失败，不再尝试 player（避免假阳性）
    return null;
  }

  // 2. player session lookup
  return resolvePlayerSession(token);
}

/**
 * 仅从 player session token（UUID）解析，不接受 admin token。
 * 用于 WS 连接等只允许 player 的场景。
 */
export async function resolvePlayerSession(token: string): Promise<Identity | null> {
  if (!token) return null;

  const now = new Date();
  const rows = await db
    .select({
      userId: schema.userSessions.userId,
      expiresAt: schema.userSessions.expiresAt,
      username: schema.users.username,
    })
    .from(schema.userSessions)
    .innerJoin(schema.users, eq(schema.userSessions.userId, schema.users.id))
    .where(and(eq(schema.userSessions.id, token), gt(schema.userSessions.expiresAt, now)))
    .limit(1);

  if (rows.length === 0) return null;
  const row = rows[0];

  // 滑动续期 last_used_at（异步 fire-and-forget，不阻塞）
  db
    .update(schema.userSessions)
    .set({ lastUsedAt: now })
    .where(eq(schema.userSessions.id, token))
    .catch(() => {});

  const isRegistered = row.username !== null;
  return {
    kind: isRegistered ? 'registered' : 'anonymous',
    userId: row.userId,
    isRegistered,
    playerUsername: row.username ?? undefined,
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

/** 要求 player 身份（匿名或注册，admin 不算） */
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
