/**
 * PlaythroughService 单元测试
 *
 * 使用真实 PostgreSQL 数据库（测试用 ivn_engine 库）。
 * 每个测试用例前清空表，保证隔离。
 *
 * 新 schema 下所有 playthroughs 必须属于某个 user；并且
 * playthroughs.script_version_id 有 FK 指向 script_versions 表，
 * 测试 helper 会自动创建 user + script + script_version。
 */

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { PlaythroughService } from '../services/playthrough-service';
import { db, schema } from '../db';
import { assertTestDatabase } from './_db-guard';
import type { ScriptManifest } from '../../../src/core/types';

const service = new PlaythroughService();

// ============================================================================
// Helpers
// ============================================================================

async function cleanTables() {
  await assertTestDatabase();
  await db.delete(schema.narrativeEntries);
  await db.delete(schema.playthroughs);
  await db.delete(schema.scriptVersions);
  await db.delete(schema.scripts);
  await db.delete(schema.userSessions);
  await db.delete(schema.users);
  await db.delete(schema.llmConfigs);
}

/** 创建一个测试用的 llm_config 行，返回 id */
async function createTestLlmConfig(): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(schema.llmConfigs).values({
    id,
    name: `test-${id.slice(0, 6)}`,
    provider: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    apiKey: 'test-key',
    model: 'test-model',
  });
  return id;
}

const TEST_CHAPTER_ID = 'ch1';

/** 一个最小可用的 ScriptManifest，用于测试 script_versions.manifest 字段 */
function makeMinimalManifest(label: string = 'test script'): ScriptManifest {
  return {
    id: 'placeholder',
    label,
    stateSchema: { variables: [] },
    memoryConfig: { contextBudget: 100000, compressionThreshold: 50000, recencyWindow: 10 },
    enabledTools: [],
    chapters: [{
      id: TEST_CHAPTER_ID,
      label: '第一章',
      flowGraph: { id: 'fg', label: 'fg', nodes: [], edges: [] },
      segments: [],
    }],
  };
}

/** 创建一个测试用户（只写 users 表，不建 auth session） */
async function createTestUser(id?: string): Promise<string> {
  const userId = id ?? crypto.randomUUID();
  await db.insert(schema.users).values({ id: userId });
  return userId;
}

/**
 * 创建测试用的 script + script_version，返回 versionId
 * scriptKey 可选用于同一测试里建多个不同剧本
 */
async function createTestScriptVersion(
  authorUserId: string,
  scriptKey: string = 'default',
): Promise<string> {
  const scriptId = `test-script-${scriptKey}-${crypto.randomUUID().slice(0, 6)}`;
  const versionId = `test-version-${scriptKey}-${crypto.randomUUID().slice(0, 6)}`;
  await db.insert(schema.scripts).values({
    id: scriptId,
    authorUserId,
    label: `test script ${scriptKey}`,
  });
  await db.insert(schema.scriptVersions).values({
    id: versionId,
    scriptId,
    versionNumber: 1,
    status: 'draft',
    manifest: makeMinimalManifest(`test script ${scriptKey}`),
    contentHash: `hash-${scriptKey}-${versionId}`,
  });
  return versionId;
}

async function createTestPlaythrough(overrides: Partial<{
  scriptVersionId: string;
  scriptKey: string;
  chapterId: string;
  userId: string;
  title: string;
  llmConfigId: string;
}> = {}) {
  // 自动创建 user 如果没指定
  const userId = overrides.userId ?? await createTestUser();
  // 自动创建 script + version 如果没指定 versionId
  const scriptVersionId =
    overrides.scriptVersionId ??
    (await createTestScriptVersion(userId, overrides.scriptKey ?? 'default'));
  // 自动创建 llm_config 如果没指定
  const llmConfigId = overrides.llmConfigId ?? (await createTestLlmConfig());
  return service.create({
    scriptVersionId,
    chapterId: overrides.chapterId ?? TEST_CHAPTER_ID,
    userId,
    title: overrides.title,
    llmConfigId,
  }).then((r) => ({ ...r, userId, scriptVersionId }));
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

    it('should auto-increment title number for same user + same version', async () => {
      const userId = await createTestUser();
      const versionId = await createTestScriptVersion(userId, 'same');
      const first = await createTestPlaythrough({ userId, scriptVersionId: versionId });
      const second = await createTestPlaythrough({ userId, scriptVersionId: versionId });
      const third = await createTestPlaythrough({ userId, scriptVersionId: versionId });
      expect(first.title).toBe('游玩 #1');
      expect(second.title).toBe('游玩 #2');
      expect(third.title).toBe('游玩 #3');
    });

    it('should count titles per script independently for same user', async () => {
      const userId = await createTestUser();
      // 建两个独立的 script + version，让同一 user 在两个剧本上各玩几次
      const versionA = await createTestScriptVersion(userId, 'a');
      const versionB = await createTestScriptVersion(userId, 'b');
      await createTestPlaythrough({ userId, scriptVersionId: versionA });
      await createTestPlaythrough({ userId, scriptVersionId: versionA });
      const bFirst = await createTestPlaythrough({ userId, scriptVersionId: versionB });
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

    it('should filter by scriptVersionId', async () => {
      const userId = await createTestUser();
      const versionA = await createTestScriptVersion(userId, 'a');
      const versionB = await createTestScriptVersion(userId, 'b');
      await createTestPlaythrough({ userId, scriptVersionId: versionA });
      await createTestPlaythrough({ userId, scriptVersionId: versionB });

      const result = await service.list({ userId, scriptVersionId: versionA });
      expect(result.length).toBe(1);
      expect(result[0].scriptVersionId).toBe(versionA);
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
  // countByScriptVersionAndUser
  // --------------------------------------------------------------------------

  describe('countByScriptVersionAndUser', () => {
    it('should count correctly per user + script', async () => {
      const u1 = await createTestUser();
      const u2 = await createTestUser();
      // 建两个版本：sa / sb；各 user 在 sa 上游玩不同次数
      const va = await createTestScriptVersion(u1, 'sa');
      const vb = await createTestScriptVersion(u1, 'sb');
      await createTestPlaythrough({ userId: u1, scriptVersionId: va });
      await createTestPlaythrough({ userId: u1, scriptVersionId: va });
      await createTestPlaythrough({ userId: u2, scriptVersionId: va });

      expect(await service.countByScriptVersionAndUser(va, u1)).toBe(2);
      expect(await service.countByScriptVersionAndUser(va, u2)).toBe(1);
      expect(await service.countByScriptVersionAndUser(vb, u1)).toBe(0);
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
