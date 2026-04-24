/**
 * ScriptVersionService 单元测试
 *
 * 覆盖版本状态机的核心路径：
 * - create 去重（相同 manifest 不创建新行）
 * - create draft vs published 状态
 * - publish（原 published 自动转 archived）
 * - deleteDraft 的约束（不能删 published/archived、不能删有 playthrough 引用的 draft）
 * - listByScript 排序
 * - getCurrentPublished
 * - listPublishedCatalog
 */

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { ScriptVersionService, hashManifest } from '../services/script-version-service';
import { scriptService } from '../services/script-service';
import { playthroughService } from '../services/playthrough-service';
import { db, schema } from '../db';
import { assertTestDatabase } from './_db-guard';
import type { ScriptManifest } from '@ivn/core/types';

const service = new ScriptVersionService();

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

function makeManifest(label: string, extraField?: string): ScriptManifest {
  return {
    id: 'placeholder',
    label,
    description: extraField,
    stateSchema: { variables: [] },
    memoryConfig: { contextBudget: 100000, compressionThreshold: 50000, recencyWindow: 10 },
    enabledTools: [],
    chapters: [{
      id: 'ch1',
      label: '第一章',
      flowGraph: { id: 'fg', label: 'fg', nodes: [], edges: [] },
      segments: [],
    }],
  };
}

async function createAuthor(): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(schema.users).values({ id });
  return id;
}

async function createScript(authorUserId: string, label = '测试剧本') {
  return await scriptService.create({ authorUserId, label });
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

describe('ScriptVersionService', () => {

  // --------------------------------------------------------------------------
  // hash
  // --------------------------------------------------------------------------

  describe('hashManifest', () => {
    it('should produce identical hash for identical manifest', () => {
      const a = makeManifest('test');
      const b = makeManifest('test');
      expect(hashManifest(a)).toBe(hashManifest(b));
    });

    it('should produce different hash when content differs', () => {
      const a = makeManifest('test', 'desc-a');
      const b = makeManifest('test', 'desc-b');
      expect(hashManifest(a)).not.toBe(hashManifest(b));
    });
  });

  // --------------------------------------------------------------------------
  // create
  // --------------------------------------------------------------------------

  describe('create', () => {
    it('should create a draft version with version_number=1', async () => {
      const u = await createAuthor();
      const s = await createScript(u);
      const result = await service.create({
        scriptId: s.id,
        manifest: makeManifest('draft v1'),
      });
      expect(result.created).toBe(true);
      expect(result.version.versionNumber).toBe(1);
      expect(result.version.status).toBe('draft');
      expect(result.version.publishedAt).toBeNull();
    });

    it('should create published version directly when status=published', async () => {
      const u = await createAuthor();
      const s = await createScript(u);
      const result = await service.create({
        scriptId: s.id,
        manifest: makeManifest('published v1'),
        status: 'published',
      });
      expect(result.version.status).toBe('published');
      expect(result.version.publishedAt).not.toBeNull();
    });

    it('should dedupe by content hash: identical manifest returns existing version', async () => {
      const u = await createAuthor();
      const s = await createScript(u);
      const manifest = makeManifest('shared');

      const r1 = await service.create({ scriptId: s.id, manifest });
      expect(r1.created).toBe(true);

      const r2 = await service.create({ scriptId: s.id, manifest });
      expect(r2.created).toBe(false);
      expect(r2.version.id).toBe(r1.version.id);
    });

    it('should auto-increment version_number for different content', async () => {
      const u = await createAuthor();
      const s = await createScript(u);

      const r1 = await service.create({ scriptId: s.id, manifest: makeManifest('v1') });
      const r2 = await service.create({ scriptId: s.id, manifest: makeManifest('v2') });
      const r3 = await service.create({ scriptId: s.id, manifest: makeManifest('v3') });

      expect(r1.version.versionNumber).toBe(1);
      expect(r2.version.versionNumber).toBe(2);
      expect(r3.version.versionNumber).toBe(3);
    });

    it('should archive previous published when creating a new published version', async () => {
      const u = await createAuthor();
      const s = await createScript(u);

      const v1 = await service.create({
        scriptId: s.id,
        manifest: makeManifest('v1'),
        status: 'published',
      });
      const v2 = await service.create({
        scriptId: s.id,
        manifest: makeManifest('v2'),
        status: 'published',
      });

      const v1After = await service.getById(v1.version.id);
      expect(v1After?.status).toBe('archived');
      expect(v1After?.archivedAt).not.toBeNull();

      const v2After = await service.getById(v2.version.id);
      expect(v2After?.status).toBe('published');
    });
  });

  // --------------------------------------------------------------------------
  // publish
  // --------------------------------------------------------------------------

  describe('publish', () => {
    it('should transition draft → published', async () => {
      const u = await createAuthor();
      const s = await createScript(u);
      const draft = await service.create({
        scriptId: s.id,
        manifest: makeManifest('draft'),
      });

      const ok = await service.publish(draft.version.id);
      expect(ok).toBe(true);

      const after = await service.getById(draft.version.id);
      expect(after?.status).toBe('published');
      expect(after?.publishedAt).not.toBeNull();
    });

    it('should archive previous published when publishing another draft', async () => {
      const u = await createAuthor();
      const s = await createScript(u);

      const draft1 = await service.create({ scriptId: s.id, manifest: makeManifest('d1') });
      await service.publish(draft1.version.id);

      const draft2 = await service.create({ scriptId: s.id, manifest: makeManifest('d2') });
      await service.publish(draft2.version.id);

      const d1After = await service.getById(draft1.version.id);
      const d2After = await service.getById(draft2.version.id);
      expect(d1After?.status).toBe('archived');
      expect(d2After?.status).toBe('published');
    });

    it('should return false when version is not in draft status', async () => {
      const u = await createAuthor();
      const s = await createScript(u);
      const v = await service.create({
        scriptId: s.id,
        manifest: makeManifest('already-published'),
        status: 'published',
      });
      const ok = await service.publish(v.version.id);
      expect(ok).toBe(false);
    });

    it('should return false when version not found', async () => {
      const ok = await service.publish('non-existent');
      expect(ok).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // deleteDraft
  // --------------------------------------------------------------------------

  describe('deleteDraft', () => {
    it('should delete a draft that has no playthroughs', async () => {
      const u = await createAuthor();
      const s = await createScript(u);
      const v = await service.create({ scriptId: s.id, manifest: makeManifest('draft') });

      const r = await service.deleteDraft(v.version.id);
      expect(r.ok).toBe(true);

      const after = await service.getById(v.version.id);
      expect(after).toBeNull();
    });

    it('should refuse to delete published version', async () => {
      const u = await createAuthor();
      const s = await createScript(u);
      const v = await service.create({
        scriptId: s.id,
        manifest: makeManifest('pub'),
        status: 'published',
      });
      const r = await service.deleteDraft(v.version.id);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('cannot_delete_published');
    });

    it('should refuse to delete draft with playthrough references', async () => {
      const u = await createAuthor();
      const s = await createScript(u);
      const v = await service.create({ scriptId: s.id, manifest: makeManifest('draft') });

      // 在此 version 上建一个 playthrough
      const llmConfigId = await createTestLlmConfig();
      await playthroughService.create({
        userId: u,
        scriptVersionId: v.version.id,
        chapterId: 'ch1',
        llmConfigId,
      });

      const r = await service.deleteDraft(v.version.id);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe('has_playthroughs');
    });
  });

  // --------------------------------------------------------------------------
  // listByScript / getCurrentPublished
  // --------------------------------------------------------------------------

  describe('list and query', () => {
    it('listByScript returns versions in desc order', async () => {
      const u = await createAuthor();
      const s = await createScript(u);
      await service.create({ scriptId: s.id, manifest: makeManifest('v1') });
      await service.create({ scriptId: s.id, manifest: makeManifest('v2') });
      await service.create({ scriptId: s.id, manifest: makeManifest('v3') });

      const list = await service.listByScript(s.id);
      expect(list.length).toBe(3);
      expect(list[0].versionNumber).toBe(3);
      expect(list[2].versionNumber).toBe(1);
    });

    it('getCurrentPublished returns the published version or null', async () => {
      const u = await createAuthor();
      const s = await createScript(u);

      let current = await service.getCurrentPublished(s.id);
      expect(current).toBeNull();

      const v = await service.create({
        scriptId: s.id,
        manifest: makeManifest('first'),
        status: 'published',
      });

      current = await service.getCurrentPublished(s.id);
      expect(current?.id).toBe(v.version.id);
    });

    it('listPublishedCatalog returns all scripts with their published version', async () => {
      const u1 = await createAuthor();
      const u2 = await createAuthor();
      const sa = await createScript(u1, 'Script A');
      const sb = await createScript(u2, 'Script B');
      const sc = await createScript(u1, 'Script C (no publish)');

      await service.create({ scriptId: sa.id, manifest: makeManifest('sa'), status: 'published' });
      await service.create({ scriptId: sb.id, manifest: makeManifest('sb'), status: 'published' });
      // sc 没有 published 版本
      await service.create({ scriptId: sc.id, manifest: makeManifest('sc') });

      const catalog = await service.listPublishedCatalog();
      expect(catalog.length).toBe(2);
      const ids = catalog.map((c) => c.scriptId).sort();
      expect(ids).toEqual([sa.id, sb.id].sort());
    });
  });
});
