/**
 * PlaythroughService 单元测试
 *
 * 使用真实 PostgreSQL 数据库（测试用 ivn_engine 库）。
 * 每个测试用例前清空表，保证隔离。
 */

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { PlaythroughService } from '../services/playthrough-service';
import { db, schema, closePool } from '../db';
import { eq } from 'drizzle-orm';

const service = new PlaythroughService();

// ============================================================================
// Helpers
// ============================================================================

async function cleanTables() {
  await db.delete(schema.narrativeEntries);
  await db.delete(schema.playthroughs);
}

const TEST_SCRIPT_ID = 'test-script-001';
const TEST_CHAPTER_ID = 'ch1';

async function createTestPlaythrough(overrides: Partial<{
  scriptId: string;
  chapterId: string;
  playerId: string | null;
  title: string;
}> = {}) {
  return service.create({
    scriptId: overrides.scriptId ?? TEST_SCRIPT_ID,
    chapterId: overrides.chapterId ?? TEST_CHAPTER_ID,
    playerId: overrides.playerId ?? null,
    title: overrides.title,
  });
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(async () => {
  await cleanTables();
});

afterAll(async () => {
  await cleanTables();
  await closePool();
});

describe('PlaythroughService', () => {

  // --------------------------------------------------------------------------
  // create
  // --------------------------------------------------------------------------

  describe('create', () => {
    it('should create a playthrough with auto-generated title', async () => {
      const result = await createTestPlaythrough();
      expect(result.id).toBeTruthy();
      expect(result.title).toBe('游玩 #1');
    });

    it('should use custom title when provided', async () => {
      const result = await createTestPlaythrough({ title: '自定义存档' });
      expect(result.title).toBe('自定义存档');
    });

    it('should auto-increment title number', async () => {
      await createTestPlaythrough();
      const second = await createTestPlaythrough();
      const third = await createTestPlaythrough();
      expect(second.title).toBe('游玩 #2');
      expect(third.title).toBe('游玩 #3');
    });

    it('should count titles per script independently', async () => {
      await createTestPlaythrough({ scriptId: 'script-a' });
      await createTestPlaythrough({ scriptId: 'script-a' });
      const bFirst = await createTestPlaythrough({ scriptId: 'script-b' });
      expect(bFirst.title).toBe('游玩 #1');
    });

    it('should count titles per player independently', async () => {
      await createTestPlaythrough({ playerId: 'player-a' });
      await createTestPlaythrough({ playerId: 'player-a' });
      const bFirst = await createTestPlaythrough({ playerId: 'player-b' });
      expect(bFirst.title).toBe('游玩 #1');
    });

    it('should set initial state correctly', async () => {
      const result = await createTestPlaythrough();
      const detail = await service.getById(result.id);
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
    it('should return empty array when no playthroughs', async () => {
      const result = await service.list();
      expect(result).toEqual([]);
    });

    it('should return playthroughs ordered by updatedAt desc', async () => {
      const a = await createTestPlaythrough({ title: 'A' });
      const b = await createTestPlaythrough({ title: 'B' });
      // Ensure timestamp difference by waiting, then update A
      await new Promise((r) => setTimeout(r, 50));
      await service.update(a.id, { title: 'A-updated' });

      const result = await service.list();
      expect(result.length).toBe(2);
      expect(result[0].title).toBe('A-updated');
      expect(result[1].title).toBe('B');
    });

    it('should filter by scriptId', async () => {
      await createTestPlaythrough({ scriptId: 'script-a' });
      await createTestPlaythrough({ scriptId: 'script-b' });

      const result = await service.list({ scriptId: 'script-a' });
      expect(result.length).toBe(1);
      expect(result[0].scriptId).toBe('script-a');
    });

    it('should filter by playerId', async () => {
      await createTestPlaythrough({ playerId: 'player-x' });
      await createTestPlaythrough({ playerId: 'player-y' });

      const result = await service.list({ playerId: 'player-x' });
      expect(result.length).toBe(1);
    });

    it('should exclude archived by default', async () => {
      const pt = await createTestPlaythrough();
      await service.update(pt.id, { archived: true });

      const result = await service.list();
      expect(result.length).toBe(0);
    });

    it('should include archived when requested', async () => {
      const pt = await createTestPlaythrough();
      await service.update(pt.id, { archived: true });

      const result = await service.list({ includeArchived: true });
      expect(result.length).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // getById
  // --------------------------------------------------------------------------

  describe('getById', () => {
    it('should return null for non-existent id', async () => {
      const result = await service.getById('non-existent');
      expect(result).toBeNull();
    });

    it('should return full detail with empty entries', async () => {
      const pt = await createTestPlaythrough();
      const detail = await service.getById(pt.id);
      expect(detail).not.toBeNull();
      expect(detail!.id).toBe(pt.id);
      expect(detail!.entries).toEqual([]);
      expect(detail!.totalEntries).toBe(0);
      expect(detail!.hasMore).toBe(false);
    });

    it('should return entries with pagination', async () => {
      const pt = await createTestPlaythrough();
      // Add 5 entries
      for (let i = 0; i < 5; i++) {
        await service.appendNarrativeEntry({
          playthroughId: pt.id,
          role: 'generate',
          content: `Entry ${i}`,
        });
      }

      // First page
      const page1 = await service.getById(pt.id, 3, 0);
      expect(page1!.entries.length).toBe(3);
      expect(page1!.totalEntries).toBe(5);
      expect(page1!.hasMore).toBe(true);
      expect(page1!.entries[0].content).toBe('Entry 0');

      // Second page
      const page2 = await service.getById(pt.id, 3, 3);
      expect(page2!.entries.length).toBe(2);
      expect(page2!.hasMore).toBe(false);
      expect(page2!.entries[0].content).toBe('Entry 3');
    });
  });

  // --------------------------------------------------------------------------
  // update
  // --------------------------------------------------------------------------

  describe('update', () => {
    it('should update title', async () => {
      const pt = await createTestPlaythrough();
      const ok = await service.update(pt.id, { title: '新标题' });
      expect(ok).toBe(true);

      const detail = await service.getById(pt.id);
      expect(detail!.title).toBe('新标题');
    });

    it('should archive playthrough', async () => {
      const pt = await createTestPlaythrough();
      await service.update(pt.id, { archived: true });

      const list = await service.list();
      expect(list.length).toBe(0);
    });

    it('should return false for non-existent id', async () => {
      const ok = await service.update('non-existent', { title: 'x' });
      expect(ok).toBe(false);
    });

    it('should update updatedAt timestamp', async () => {
      const pt = await createTestPlaythrough();
      const before = (await service.getById(pt.id))!.updatedAt;

      // Small delay to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 50));
      await service.update(pt.id, { title: 'updated' });

      const after = (await service.getById(pt.id))!.updatedAt;
      expect(after.getTime()).toBeGreaterThan(before.getTime());
    });
  });

  // --------------------------------------------------------------------------
  // delete
  // --------------------------------------------------------------------------

  describe('delete', () => {
    it('should delete playthrough', async () => {
      const pt = await createTestPlaythrough();
      const ok = await service.delete(pt.id);
      expect(ok).toBe(true);

      const detail = await service.getById(pt.id);
      expect(detail).toBeNull();
    });

    it('should cascade delete narrative entries', async () => {
      const pt = await createTestPlaythrough();
      await service.appendNarrativeEntry({
        playthroughId: pt.id,
        role: 'generate',
        content: 'test',
      });

      await service.delete(pt.id);

      // Verify entries are also deleted
      const entries = await service.loadEntries(pt.id, 100);
      expect(entries.length).toBe(0);
    });

    it('should return false for non-existent id', async () => {
      const ok = await service.delete('non-existent');
      expect(ok).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // updateState (persistence helper)
  // --------------------------------------------------------------------------

  describe('updateState', () => {
    it('should update status and turn', async () => {
      const pt = await createTestPlaythrough();
      await service.updateState(pt.id, { status: 'generating', turn: 1 });

      const detail = await service.getById(pt.id);
      expect(detail!.status).toBe('generating');
      expect(detail!.turn).toBe(1);
    });

    it('should update memory snapshot', async () => {
      const pt = await createTestPlaythrough();
      const memoryEntries = [{ role: 'generate', content: 'test', turn: 1 }];
      const memorySummaries = ['summary 1'];
      await service.updateState(pt.id, { memoryEntries, memorySummaries });

      const detail = await service.getById(pt.id);
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

      const detail = await service.getById(pt.id);
      expect(detail!.status).toBe('waiting-input');
      expect(detail!.inputHint).toBe('你要怎么做？');
      expect(detail!.inputType).toBe('choice');
      expect(detail!.choices).toEqual(['选项A', '选项B']);
    });

    it('should update preview', async () => {
      const pt = await createTestPlaythrough();
      await service.updateState(pt.id, { preview: '你推开石门...' });

      const detail = await service.getById(pt.id);
      expect(detail!.preview).toBe('你推开石门...');
    });
  });

  // --------------------------------------------------------------------------
  // appendNarrativeEntry
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
      expect(entries[0].role).toBe('system');
      expect(entries[1].role).toBe('generate');
      expect(entries[2].role).toBe('receive');
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
  // countByScriptAndPlayer
  // --------------------------------------------------------------------------

  describe('countByScriptAndPlayer', () => {
    it('should count correctly', async () => {
      await createTestPlaythrough({ scriptId: 'sa', playerId: 'p1' });
      await createTestPlaythrough({ scriptId: 'sa', playerId: 'p1' });
      await createTestPlaythrough({ scriptId: 'sa', playerId: 'p2' });

      expect(await service.countByScriptAndPlayer('sa', 'p1')).toBe(2);
      expect(await service.countByScriptAndPlayer('sa', 'p2')).toBe(1);
      expect(await service.countByScriptAndPlayer('sb', 'p1')).toBe(0);
    });

    it('should handle null playerId', async () => {
      await createTestPlaythrough({ scriptId: 'sa' }); // null player
      await createTestPlaythrough({ scriptId: 'sa', playerId: 'p1' });

      expect(await service.countByScriptAndPlayer('sa', null)).toBe(1);
    });
  });
});
