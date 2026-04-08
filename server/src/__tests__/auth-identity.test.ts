/**
 * auth-identity 单元测试
 *
 * 覆盖：
 * - resolveIdentity: admin / player / anonymous 各路径
 * - resolvePlayerSession: 有效 / 过期 / 不存在
 * - requirePlayer / requireAdmin / requireAnyIdentity 守卫行为
 * - UserService: 创建匿名用户 + session, 删除, 过期清理
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  resolveIdentity,
  resolvePlayerSession,
  requirePlayer,
  requireAdmin,
  requireAnyIdentity,
  isResponse,
} from '../auth-identity';
import { userService } from '../services/user-service';
import { generateToken } from '../auth';
import { db, schema } from '../db';
import { eq } from 'drizzle-orm';

// ============================================================================
// Helpers
// ============================================================================

async function cleanTables() {
  await db.delete(schema.narrativeEntries);
  await db.delete(schema.playthroughs);
  await db.delete(schema.userSessions);
  await db.delete(schema.users);
}

function makeReq(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/test', { headers });
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(async () => {
  await cleanTables();
});

describe('auth-identity', () => {

  // --------------------------------------------------------------------------
  // UserService.createAnonymous
  // --------------------------------------------------------------------------

  describe('UserService.createAnonymous', () => {
    it('should create anonymous user + session', async () => {
      const result = await userService.createAnonymous();
      expect(result.userId).toBeTruthy();
      expect(result.sessionId).toBeTruthy();
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());

      // User row exists
      const user = await userService.getById(result.userId);
      expect(user).not.toBeNull();
      expect(user!.username).toBeNull(); // anonymous

      // Session row exists
      const session = await db
        .select()
        .from(schema.userSessions)
        .where(eq(schema.userSessions.id, result.sessionId))
        .limit(1);
      expect(session.length).toBe(1);
      expect(session[0].userId).toBe(result.userId);
    });

    it('should set expiresAt ~1 year in future', async () => {
      const { expiresAt } = await userService.createAnonymous();
      const delta = expiresAt.getTime() - Date.now();
      const oneYearMs = 365 * 24 * 60 * 60 * 1000;
      // 允许 5 秒误差
      expect(Math.abs(delta - oneYearMs)).toBeLessThan(5000);
    });
  });

  // --------------------------------------------------------------------------
  // resolvePlayerSession
  // --------------------------------------------------------------------------

  describe('resolvePlayerSession', () => {
    it('should return identity for valid session', async () => {
      const { userId, sessionId } = await userService.createAnonymous();
      const identity = await resolvePlayerSession(sessionId);
      expect(identity).not.toBeNull();
      expect(identity!.userId).toBe(userId);
      expect(identity!.kind).toBe('anonymous');
      expect(identity!.isRegistered).toBe(false);
    });

    it('should return null for non-existent session', async () => {
      const identity = await resolvePlayerSession('non-existent-uuid');
      expect(identity).toBeNull();
    });

    it('should return null for expired session', async () => {
      // 手动创建一个已过期的 session
      const userId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      await db.insert(schema.users).values({ id: userId });
      await db.insert(schema.userSessions).values({
        id: sessionId,
        userId,
        expiresAt: new Date(Date.now() - 1000), // 已过期
      });

      const identity = await resolvePlayerSession(sessionId);
      expect(identity).toBeNull();
    });

    it('should return null for empty token', async () => {
      const identity = await resolvePlayerSession('');
      expect(identity).toBeNull();
    });

    it('should mark registered user correctly', async () => {
      const { userId, sessionId } = await userService.createAnonymous();
      // 模拟"注册"：设置 username
      await db
        .update(schema.users)
        .set({ username: 'testuser' })
        .where(eq(schema.users.id, userId));

      const identity = await resolvePlayerSession(sessionId);
      expect(identity).not.toBeNull();
      expect(identity!.kind).toBe('registered');
      expect(identity!.isRegistered).toBe(true);
      expect(identity!.playerUsername).toBe('testuser');
    });
  });

  // --------------------------------------------------------------------------
  // resolveIdentity — 从 Request 解析
  // --------------------------------------------------------------------------

  describe('resolveIdentity', () => {
    it('should return null when no Authorization header', async () => {
      const identity = await resolveIdentity(makeReq());
      expect(identity).toBeNull();
    });

    it('should return null when Authorization is not Bearer', async () => {
      const identity = await resolveIdentity(makeReq({ Authorization: 'Basic xxx' }));
      expect(identity).toBeNull();
    });

    it('should resolve player session via Authorization header', async () => {
      const { userId, sessionId } = await userService.createAnonymous();
      const identity = await resolveIdentity(
        makeReq({ Authorization: `Bearer ${sessionId}` }),
      );
      expect(identity).not.toBeNull();
      expect(identity!.kind).toBe('anonymous');
      expect(identity!.userId).toBe(userId);
    });

    it('should resolve admin token', async () => {
      const adminToken = await generateToken('admin');
      const identity = await resolveIdentity(
        makeReq({ Authorization: `Bearer ${adminToken}` }),
      );
      expect(identity).not.toBeNull();
      expect(identity!.kind).toBe('admin');
      expect(identity!.userId).toBe('admin');
      expect(identity!.isRegistered).toBe(true);
    });

    it('should reject invalid admin token format without trying player', async () => {
      // 构造看起来像 admin token 但签名错误的 token
      const fakeToken = 'fake:123:bad-signature';
      const identity = await resolveIdentity(
        makeReq({ Authorization: `Bearer ${fakeToken}` }),
      );
      expect(identity).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // requirePlayer / requireAdmin / requireAnyIdentity
  // --------------------------------------------------------------------------

  describe('requirePlayer', () => {
    it('should return identity for valid player', async () => {
      const { sessionId } = await userService.createAnonymous();
      const result = await requirePlayer(
        makeReq({ Authorization: `Bearer ${sessionId}` }),
      );
      expect(isResponse(result)).toBe(false);
      if (!isResponse(result)) {
        expect(result.kind).toBe('anonymous');
      }
    });

    it('should return 401 Response when no auth', async () => {
      const result = await requirePlayer(makeReq());
      expect(isResponse(result)).toBe(true);
      if (isResponse(result)) expect(result.status).toBe(401);
    });

    it('should return 403 Response for admin identity', async () => {
      const adminToken = await generateToken('admin');
      const result = await requirePlayer(
        makeReq({ Authorization: `Bearer ${adminToken}` }),
      );
      expect(isResponse(result)).toBe(true);
      if (isResponse(result)) expect(result.status).toBe(403);
    });
  });

  describe('requireAdmin', () => {
    it('should return identity for admin', async () => {
      const adminToken = await generateToken('admin');
      const result = await requireAdmin(
        makeReq({ Authorization: `Bearer ${adminToken}` }),
      );
      expect(isResponse(result)).toBe(false);
      if (!isResponse(result)) expect(result.kind).toBe('admin');
    });

    it('should return 403 Response for player', async () => {
      const { sessionId } = await userService.createAnonymous();
      const result = await requireAdmin(
        makeReq({ Authorization: `Bearer ${sessionId}` }),
      );
      expect(isResponse(result)).toBe(true);
      if (isResponse(result)) expect(result.status).toBe(403);
    });

    it('should return 403 Response without auth', async () => {
      const result = await requireAdmin(makeReq());
      expect(isResponse(result)).toBe(true);
      if (isResponse(result)) expect(result.status).toBe(403);
    });
  });

  describe('requireAnyIdentity', () => {
    it('should return identity for admin', async () => {
      const adminToken = await generateToken('admin');
      const result = await requireAnyIdentity(
        makeReq({ Authorization: `Bearer ${adminToken}` }),
      );
      expect(isResponse(result)).toBe(false);
    });

    it('should return identity for player', async () => {
      const { sessionId } = await userService.createAnonymous();
      const result = await requireAnyIdentity(
        makeReq({ Authorization: `Bearer ${sessionId}` }),
      );
      expect(isResponse(result)).toBe(false);
    });

    it('should return 401 Response without auth', async () => {
      const result = await requireAnyIdentity(makeReq());
      expect(isResponse(result)).toBe(true);
      if (isResponse(result)) expect(result.status).toBe(401);
    });
  });

  // --------------------------------------------------------------------------
  // UserService.deleteSession
  // --------------------------------------------------------------------------

  describe('UserService.deleteSession', () => {
    it('should delete session by id', async () => {
      const { sessionId } = await userService.createAnonymous();
      const ok = await userService.deleteSession(sessionId);
      expect(ok).toBe(true);

      // Session no longer resolvable
      const identity = await resolvePlayerSession(sessionId);
      expect(identity).toBeNull();
    });

    it('should return false for non-existent session', async () => {
      const ok = await userService.deleteSession('non-existent');
      expect(ok).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // UserService.cleanExpiredSessions
  // --------------------------------------------------------------------------

  describe('UserService.cleanExpiredSessions', () => {
    it('should remove only expired sessions', async () => {
      const userId = crypto.randomUUID();
      await db.insert(schema.users).values({ id: userId });

      // 1 个有效 + 2 个过期
      await db.insert(schema.userSessions).values([
        {
          id: 'valid-1',
          userId,
          expiresAt: new Date(Date.now() + 10 * 60 * 1000),
        },
        {
          id: 'expired-1',
          userId,
          expiresAt: new Date(Date.now() - 1000),
        },
        {
          id: 'expired-2',
          userId,
          expiresAt: new Date(Date.now() - 60 * 1000),
        },
      ]);

      const removed = await userService.cleanExpiredSessions();
      expect(removed).toBe(2);

      // 验证只剩有效的
      const remaining = await db.select().from(schema.userSessions);
      expect(remaining.length).toBe(1);
      expect(remaining[0].id).toBe('valid-1');
    });
  });
});
