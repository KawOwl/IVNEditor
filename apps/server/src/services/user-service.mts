/**
 * UserService — 用户 + auth session 的业务逻辑
 *
 * 封装 users 和 user_sessions 表的所有操作。
 * Route 层和 middleware 都通过这个 service 交互 DB。
 */

import { eq, and, gt, lt, isNull, sql } from 'drizzle-orm';
import { db, schema } from '#internal/db';

// ============================================================================
// Types
// ============================================================================

export interface UserRow {
  id: string;
  username: string | null;
  displayName: string | null;
  createdAt: Date;
  lastSeenAt: Date;
}

export interface CreateAnonymousResult {
  userId: string;
  sessionId: string;
  expiresAt: Date;
}

/** 匿名 session 默认 1 年过期 */
const DEFAULT_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

// ============================================================================
// Service
// ============================================================================

export class UserService {
  /**
   * 创建匿名用户 + 对应的 session
   * 返回客户端用的 sessionId
   */
  async createAnonymous(): Promise<CreateAnonymousResult> {
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + DEFAULT_SESSION_TTL_MS);

    await db.transaction(async (tx) => {
      await tx.insert(schema.users).values({
        id: userId,
        createdAt: now,
        lastSeenAt: now,
      });
      await tx.insert(schema.userSessions).values({
        id: sessionId,
        userId,
        createdAt: now,
        lastUsedAt: now,
        expiresAt,
      });
    });

    return { userId, sessionId, expiresAt };
  }

  /**
   * 查询用户信息
   */
  async getById(userId: string): Promise<UserRow | null> {
    const rows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);

    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
    };
  }

  /**
   * 更新 last_seen_at（可在关键业务调用时触发）
   */
  async touchLastSeen(userId: string): Promise<void> {
    await db
      .update(schema.users)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.users.id, userId));
  }

  /**
   * 根据 sessionId 查用户。已过期返回 null。
   * （注意：用 auth-identity.resolvePlayerSession 会更合适——这个只在 service 内部用）
   */
  async getUserBySessionId(sessionId: string): Promise<UserRow | null> {
    const now = new Date();
    const rows = await db
      .select({
        id: schema.users.id,
        username: schema.users.username,
        displayName: schema.users.displayName,
        createdAt: schema.users.createdAt,
        lastSeenAt: schema.users.lastSeenAt,
      })
      .from(schema.userSessions)
      .innerJoin(schema.users, eq(schema.userSessions.userId, schema.users.id))
      .where(
        and(
          eq(schema.userSessions.id, sessionId),
          gt(schema.userSessions.expiresAt, now),
        ),
      )
      .limit(1);

    if (rows.length === 0) return null;
    return rows[0];
  }

  /**
   * 删除指定 session（登出）
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const result = await db
      .delete(schema.userSessions)
      .where(eq(schema.userSessions.id, sessionId))
      .returning({ id: schema.userSessions.id });
    return result.length > 0;
  }

  /**
   * 清理过期的 sessions（定时任务调用）
   */
  async cleanExpiredSessions(): Promise<number> {
    const result = await db
      .delete(schema.userSessions)
      .where(lt(schema.userSessions.expiresAt, new Date()))
      .returning({ id: schema.userSessions.id });
    return result.length;
  }

  /**
   * 把当前匿名 user 升级为注册用户（PFB.2）。
   *
   * 只在 users 行 password_hash IS NULL 时升级（用 WHERE 子句保证幂等 +
   * 防 race），同 transaction 内 insert user_profiles。失败按 reason 回报：
   *   - 'not-anonymous' — 当前 user 已有 password_hash（非匿名）
   *   - 'email-taken'   — email 被其他 user 占用（unique constraint 撞 23505）
   *
   * 不签发新 token —— sessionId 仍指向同一 user.id，调用方 checkMe()
   * 后 kind 自然从 anonymous 变 registered。
   */
  async upgradeAnonymousToRegistered(input: {
    userId: string;
    email: string;
    passwordHash: string;
    profile: {
      affiliation: string;
      gender: string;
      grade: string;
      major: string;
      monthlyBudget: string;
      hobbies: string[];
    };
  }): Promise<{ ok: true } | { ok: false; reason: 'not-anonymous' | 'email-taken' }> {
    try {
      return await db.transaction(async (tx) => {
        const updated = await tx
          .update(schema.users)
          .set({
            email: input.email,
            passwordHash: input.passwordHash,
            lastSeenAt: sql`NOW()`,
          })
          .where(
            and(
              eq(schema.users.id, input.userId),
              isNull(schema.users.passwordHash),
            ),
          )
          .returning({ id: schema.users.id });

        if (updated.length === 0) {
          return { ok: false, reason: 'not-anonymous' as const };
        }

        await tx.insert(schema.userProfiles).values({
          userId: input.userId,
          affiliation: input.profile.affiliation,
          gender: input.profile.gender,
          grade: input.profile.grade,
          major: input.profile.major,
          monthlyBudget: input.profile.monthlyBudget,
          hobbies: input.profile.hobbies,
        });

        return { ok: true as const };
      });
    } catch (err: unknown) {
      // pg unique violation = SQLSTATE 23505。email 唯一约束撞了。
      if (
        err !== null &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code?: string }).code === '23505'
      ) {
        return { ok: false, reason: 'email-taken' };
      }
      throw err;
    }
  }
}

export const userService = new UserService();
