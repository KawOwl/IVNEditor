/**
 * PlaythroughService 单元测试
 *
 * 使用真实 PostgreSQL 数据库（测试用 ivn_engine 库）。
 * 每个测试用例前清空表，保证隔离。
 *
 * 新 schema 下所有 playthroughs 必须属于某个 user，测试 helper 会自动创建。
 */

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { PlaythroughService } from '../services/playthrough-service';
import { db, schema } from '../db';

const service = new PlaythroughService();

// ============================================================================
// Helpers
// ============================================================================

async function cleanTables() {
  await db.delete(schema.narrativeEntries);
  await db.delete(schema.playthroughs);
  await db.delete(schema.userSessions);
  await db.delete(schema.users);
}

const TEST_SCRIPT_ID = 'test-script-001';
const TEST_CHAPTER_ID = 'ch1';

/** 创建一个测试用户（只写 users 表，不建 auth session） */
async function createTestUser(id?: string): Promise<string> {
  const userId = id ?? crypto.randomUUID();
  await db.insert(schema.users).values({ id: userId });
  return userId;
}

async function createTestPlaythrough(overrides: Partial<{
  scriptId: string;
  chapterId: string;
  userId: string;
  title: string;
}> = {}) {
  // 自动创建 user 如果没指定
  const userId = overrides.userId ?? await createTestUser();
  return service.create({
    scriptId: overrides.scriptId ?? TEST_SCRIPT_ID,
    chapterId: overrides.chapterId ?? TEST_CHAPTER_ID,
    userId,
    title: overrides.title,
  }).then((r) => ({ ...r, userId }));
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(async () => {
  await cleanTables();
});

afterAll(async () => {
  await cleanTables();
});

describe('PlaythroughService', () => {

  // --------------------------------------------------------------------------
  // create
  // --------------------------------------------------------------------------

  describe('create', () => {
    it('should create a playthrough with auto-generated title', async () => {
      const pt = await createTestPlaythrough();
      expect(pt.id).toBeTruthy();
      expect(pt.title).toBe('游玩 #1');
    });

    it('should use custom title when provided', async () => {
      const pt = await createTestPlaythrough({ title: '自定义存档' });
      expect(pt.title).toBe('自定义存档');
    });

    it('should auto-increment title number for same user', async () => {
      const userId = await createTestUser();
      const first = await createTestPlaythrough({ userId });
      const second = await createTestPlaythrough({ userId });
      const third = await createTestPlaythrough({ userId });
      expect(first.title).toBe('游玩 #1');
      expect(second.title).toBe('游玩 #2');
      expect(third.title).toBe('游玩 #3');
    });

    it('should count titles per script independently for same user', async () => {
      const userId = await createTestUser();
      await createTestPlaythrough({ userId, scriptId: 'script-a' });
      await createTestPlaythrough({ userId, scriptId: 'script-a' });
      const bFirst = await createTestPlaythrough({ userId, scriptId: 'script-b' });
      expect(bFirst.title).toBe('游玩 #1');
    });

    it('should count titles per user independently', async () => {
      const userA = await createTestUser();
      const userB = await createTestUser();
      await createTestPlaythrough({ userId: userA });
      await createTestPlaythrough({ userId: userA });
      const bFirst = await createTestPlaythrough({ userId: userB });
      expect(bFirst.title).toBe('游玩 #1');
    });

    it('should set initial state correctly', async () => {
      const pt = await createTestPlaythrough();
      const detail = await service.getById(pt.id, pt.userId);
      expect(detail).not.toBeNull();
      expect(detail!.status).toBe('idle');
      expect(detail!.turn).toBe(0);
      expect(detail!.stateVars).toEqual({});
      expect(detail!.memoryEntries).toEqual([]);
      expect(detail!.memorySummaries).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // list
  // --------------------------------------------------------------------------

  describe('list', () => {
    it('should return empty array for new user', async () => {
      const userId = await createTestUser();
      const result = await service.list({ userId });
      expect(result).toEqual([]);
    });

    it('should return playthroughs ordered by updatedAt desc', async () => {
      const userId = await createTestUser();
      const a = await createTestPlaythrough({ userId, title: 'A' });
      await new Promise((r) => setTimeout(r, 100));
      await createTestPlaythrough({ userId, title: 'B' });
      await new Promise((r) => setTimeout(r, 100));
      await service.update(a.id, userId, { title: 'A-updated' });

      const result = await service.list({ userId });
      expect(result.length).toBe(2);
      expect(result[0].title).toBe('A-updated'); // A was updated last
      expect(result[1].title).toBe('B');
    });

    it('should filter by scriptId', async () => {
      const userId = await createTestUser();
      await createTestPlaythrough({ userId, scriptId: 'script-a' });
      await createTestPlaythrough({ userId, scriptId: 'script-b' });

      const result = await service.list({ userId, scriptId: 'script-a' });
      expect(result.length).toBe(1);
      expect(result[0].scriptId).toBe('script-a');
    });

    it('should NOT return other users playthroughs (ownership enforced)', async () => {
      const userA = await createTestUser();
      const userB = await createTestUser();
      await createTestPlaythrough({ userId: userA });
      await createTestPlaythrough({ userId: userA });
      await createTestPlaythrough({ userId: userB });

      const aList = await service.list({ userId: userA });
      const bList = await service.list({ userId: userB });

      expect(aList.length).toBe(2);
      expect(bList.length).toBe(1);
    });

    it('should exclude archived by default', async () => {
      const pt = await createTestPlaythrough();
      await service.update(pt.id, pt.userId, { archived: true });

      const result = await service.list({ userId: pt.userId });
      expect(result.length).toBe(0);
    });

    it('should include archived when requested', async () => {
      const pt = await createTestPlaythrough();
      await service.update(pt.id, pt.userId, { archived: true });

      const result = await service.list({ userId: pt.userId, includeArchived: true });
      expect(result.length).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // getById (ownership enforced)
  // --------------------------------------------------------------------------

  describe('getById', () => {
    it('should return null for non-existent id', async () => {
      const userId = await createTestUser();
      const result = await service.getById('non-existent', userId);
      expect(result).toBeNull();
    });

    it('should return full detail with empty entries', async () => {
      const pt = await createTestPlaythrough();
      const detail = await service.getById(pt.id, pt.userId);
      expect(detail).not.toBeNull();
      expect(detail!.id).toBe(pt.id);
      expect(detail!.entries).toEqual([]);
      expect(detail!.totalEntries).toBe(0);
      expect(detail!.hasMore).toBe(false);
    });

    it('should return entries with pagination', async () => {
      const pt = await createTestPlaythrough();
      for (let i = 0; i < 5; i++) {
        await service.appendNarrativeEntry({
          playthroughId: pt.id,
          role: 'generate',
          content: `Entry ${i}`,
        });
      }

      const page1 = await service.getById(pt.id, pt.userId, 3, 0);
      expect(page1!.entries.length).toBe(3);
      expect(page1!.totalEntries).toBe(5);
      expect(page1!.hasMore).toBe(true);
      expect(page1!.entries[0].content).toBe('Entry 0');

      const page2 = await service.getById(pt.id, pt.userId, 3, 3);
      expect(page2!.entries.length).toBe(2);
      expect(page2!.hasMore).toBe(false);
      expect(page2!.entries[0].content).toBe('Entry 3');
    });

    it('should return null when accessed by non-owner (ownership check)', async () => {
      const pt = await createTestPlaythrough();
      const otherUserId = await createTestUser();

      const result = await service.getById(pt.id, otherUserId);
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // update (ownership enforced)
  // --------------------------------------------------------------------------

  describe('update', () => {
    it('should update title', async () => {
      const pt = await createTestPlaythrough();
      const ok = await service.update(pt.id, pt.userId, { title: '新标题' });
      expect(ok).toBe(true);

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.title).toBe('新标题');
    });

    it('should archive playthrough', async () => {
      const pt = await createTestPlaythrough();
      await service.update(pt.id, pt.userId, { archived: true });

      const list = await service.list({ userId: pt.userId });
      expect(list.length).toBe(0);
    });

    it('should return false for non-existent id', async () => {
      const userId = await createTestUser();
      const ok = await service.update('non-existent', userId, { title: 'x' });
      expect(ok).toBe(false);
    });

    it('should return false when accessed by non-owner', async () => {
      const pt = await createTestPlaythrough();
      const otherUserId = await createTestUser();
      const ok = await service.update(pt.id, otherUserId, { title: 'hacked' });
      expect(ok).toBe(false);

      // Verify the original title hasn't changed
      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.title).toBe('游玩 #1');
    });

    it('should update updatedAt timestamp', async () => {
      const pt = await createTestPlaythrough();
      const before = (await service.getById(pt.id, pt.userId))!.updatedAt;

      await new Promise((r) => setTimeout(r, 50));
      await service.update(pt.id, pt.userId, { title: 'updated' });

      const after = (await service.getById(pt.id, pt.userId))!.updatedAt;
      expect(after.getTime()).toBeGreaterThan(before.getTime());
    });
  });

  // --------------------------------------------------------------------------
  // delete (ownership enforced)
  // --------------------------------------------------------------------------

  describe('delete', () => {
    it('should delete playthrough', async () => {
      const pt = await createTestPlaythrough();
      const ok = await service.delete(pt.id, pt.userId);
      expect(ok).toBe(true);

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail).toBeNull();
    });

    it('should cascade delete narrative entries', async () => {
      const pt = await createTestPlaythrough();
      await service.appendNarrativeEntry({
        playthroughId: pt.id,
        role: 'generate',
        content: 'test',
      });

      await service.delete(pt.id, pt.userId);

      const entries = await service.loadEntries(pt.id, 100);
      expect(entries.length).toBe(0);
    });

    it('should return false for non-existent id', async () => {
      const userId = await createTestUser();
      const ok = await service.delete('non-existent', userId);
      expect(ok).toBe(false);
    });

    it('should return false when accessed by non-owner', async () => {
      const pt = await createTestPlaythrough();
      const otherUserId = await createTestUser();
      const ok = await service.delete(pt.id, otherUserId);
      expect(ok).toBe(false);

      // Original playthrough should still exist
      const detail = await service.getById(pt.id, pt.userId);
      expect(detail).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // updateState (persistence helper, no ownership check — internal)
  // --------------------------------------------------------------------------

  describe('updateState', () => {
    it('should update status and turn', async () => {
      const pt = await createTestPlaythrough();
      await service.updateState(pt.id, { status: 'generating', turn: 1 });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.status).toBe('generating');
      expect(detail!.turn).toBe(1);
    });

    it('should update memory snapshot', async () => {
      const pt = await createTestPlaythrough();
      const memoryEntries = [{ role: 'generate', content: 'test', turn: 1 }];
      const memorySummaries = ['summary 1'];
      await service.updateState(pt.id, { memoryEntries, memorySummaries });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.memoryEntries).toEqual(memoryEntries);
      expect(detail!.memorySummaries).toEqual(memorySummaries);
    });

    it('should update choices and input state', async () => {
      const pt = await createTestPlaythrough();
      await service.updateState(pt.id, {
        status: 'waiting-input',
        inputHint: '你要怎么做？',
        inputType: 'choice',
        choices: ['选项A', '选项B'],
      });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.status).toBe('waiting-input');
      expect(detail!.inputHint).toBe('你要怎么做？');
      expect(detail!.inputType).toBe('choice');
      expect(detail!.choices).toEqual(['选项A', '选项B']);
    });

    it('should update preview', async () => {
      const pt = await createTestPlaythrough();
      await service.updateState(pt.id, { preview: '你推开石门...' });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.preview).toBe('你推开石门...');
    });
  });

  // --------------------------------------------------------------------------
  // appendNarrativeEntry (persistence helper)
  // --------------------------------------------------------------------------

  describe('appendNarrativeEntry', () => {
    it('should create entry with auto-incrementing orderIdx', async () => {
      const pt = await createTestPlaythrough();

      await service.appendNarrativeEntry({
        playthroughId: pt.id,
        role: 'system',
        content: 'Welcome',
      });
      await service.appendNarrativeEntry({
        playthroughId: pt.id,
        role: 'generate',
        content: 'Hello',
      });
      await service.appendNarrativeEntry({
        playthroughId: pt.id,
        role: 'receive',
        content: 'Hi',
      });

      const entries = await service.loadEntries(pt.id, 100);
      expect(entries.length).toBe(3);
      expect(entries[0].orderIdx).toBe(0);
      expect(entries[1].orderIdx).toBe(1);
      expect(entries[2].orderIdx).toBe(2);
    });

    it('should store optional fields', async () => {
      const pt = await createTestPlaythrough();
      await service.appendNarrativeEntry({
        playthroughId: pt.id,
        role: 'generate',
        content: 'narrative',
        reasoning: 'thinking...',
        toolCalls: [{ name: 'update_state', args: {}, result: 'ok' }],
        finishReason: 'stop',
      });

      const entries = await service.loadEntries(pt.id, 1);
      expect(entries[0].reasoning).toBe('thinking...');
      expect(entries[0].toolCalls).toEqual([{ name: 'update_state', args: {}, result: 'ok' }]);
      expect(entries[0].finishReason).toBe('stop');
    });

    it('should return entry id', async () => {
      const pt = await createTestPlaythrough();
      const id = await service.appendNarrativeEntry({
        playthroughId: pt.id,
        role: 'generate',
        content: 'test',
      });
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });
  });

  // --------------------------------------------------------------------------
  // loadEntries
  // --------------------------------------------------------------------------

  describe('loadEntries', () => {
    it('should load entries with offset and limit', async () => {
      const pt = await createTestPlaythrough();
      for (let i = 0; i < 10; i++) {
        await service.appendNarrativeEntry({
          playthroughId: pt.id,
          role: 'generate',
          content: `Entry ${i}`,
        });
      }

      const page = await service.loadEntries(pt.id, 3, 5);
      expect(page.length).toBe(3);
      expect(page[0].content).toBe('Entry 5');
      expect(page[2].content).toBe('Entry 7');
    });

    it('should return empty array for non-existent playthrough', async () => {
      const entries = await service.loadEntries('non-existent', 10);
      expect(entries).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // countByScriptAndUser
  // --------------------------------------------------------------------------

  describe('countByScriptAndUser', () => {
    it('should count correctly per user + script', async () => {
      const u1 = await createTestUser();
      const u2 = await createTestUser();
      await createTestPlaythrough({ userId: u1, scriptId: 'sa' });
      await createTestPlaythrough({ userId: u1, scriptId: 'sa' });
      await createTestPlaythrough({ userId: u2, scriptId: 'sa' });

      expect(await service.countByScriptAndUser('sa', u1)).toBe(2);
      expect(await service.countByScriptAndUser('sa', u2)).toBe(1);
      expect(await service.countByScriptAndUser('sb', u1)).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // getOwnerId (internal helper)
  // --------------------------------------------------------------------------

  describe('getOwnerId', () => {
    it('should return user id for existing playthrough', async () => {
      const pt = await createTestPlaythrough();
      const ownerId = await service.getOwnerId(pt.id);
      expect(ownerId).toBe(pt.userId);
    });

    it('should return null for non-existent playthrough', async () => {
      const ownerId = await service.getOwnerId('non-existent');
      expect(ownerId).toBeNull();
    });
  });
});
