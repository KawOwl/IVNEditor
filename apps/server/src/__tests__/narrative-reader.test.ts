/**
 * NarrativeHistoryReader server 实现单测。
 *
 * 见 .claude/plans/messages-model.md。
 */

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { createNarrativeHistoryReader } from '#server/services/narrative-reader';
import { playthroughService } from '#server/services/playthrough-service';
import { db, schema } from '#server/db';
import { assertTestDatabase } from './_db-guard';
import type { ScriptManifest } from '@ivn/core/types';

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
    name: `t-${id.slice(0, 6)}`,
    provider: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    model: 'm',
  });
  return id;
}

async function createTestPlaythrough(): Promise<{ id: string; userId: string }> {
  const userId = crypto.randomUUID();
  await db.insert(schema.users).values({ id: userId });

  const scriptId = `s-${crypto.randomUUID().slice(0, 8)}`;
  const versionId = `v-${crypto.randomUUID().slice(0, 8)}`;
  const llmConfigId = await createTestLlmConfig();

  await db.insert(schema.scripts).values({ id: scriptId, authorUserId: userId, label: 't' });
  await db.insert(schema.scriptVersions).values({
    id: versionId,
    scriptId,
    versionNumber: 1,
    status: 'draft',
    contentHash: `hash-${versionId}`,
    manifest: {
      id: scriptId, label: 't', stateSchema: { variables: [] },
      memoryConfig: { contextBudget: 100000, compressionThreshold: 50000, recencyWindow: 10 },
      enabledTools: [],
      chapters: [{
        id: 'ch1', label: 'ch1',
        flowGraph: { id: 'fg', label: 'fg', nodes: [], edges: [] },
        segments: [],
      }],
    } satisfies ScriptManifest,
  });

  const id = crypto.randomUUID();
  await db.insert(schema.playthroughs).values({
    id, userId, scriptVersionId: versionId, llmConfigId, kind: 'production',
    chapterId: 'ch1', status: 'idle',
  });
  return { id, userId };
}

describe('NarrativeHistoryReader', () => {
  beforeEach(async () => {
    await cleanTables();
  });

  afterAll(async () => {
    await cleanTables();
  });

  describe('readRecent', () => {
    it('返回 N 条 entries（orderIdx 升序）', async () => {
      const pt = await createTestPlaythrough();
      const items: Array<{ kind: 'narrative' | 'signal_input' | 'player_input'; role: string; content: string }> = [
        { kind: 'narrative', role: 'generate', content: '段1' },
        { kind: 'signal_input', role: 'system', content: 'Q?' },
        { kind: 'player_input', role: 'receive', content: '答' },
        { kind: 'narrative', role: 'generate', content: '段2' },
      ];
      for (const it of items) {
        await playthroughService.appendNarrativeEntry({
          playthroughId: pt.id,
          role: it.role,
          kind: it.kind,
          content: it.content,
        });
      }

      const reader = createNarrativeHistoryReader(pt.id);
      const result = await reader.readRecent({ limit: 10 });
      expect(result.map((e) => e.content)).toEqual(['段1', 'Q?', '答', '段2']);
      for (let i = 1; i < result.length; i++) {
        expect(result[i]!.orderIdx).toBeGreaterThan(result[i - 1]!.orderIdx);
      }
    });

    it('kinds 过滤', async () => {
      const pt = await createTestPlaythrough();
      await playthroughService.appendNarrativeEntry({ playthroughId: pt.id, role: 'generate', kind: 'narrative', content: 'n1' });
      await playthroughService.appendNarrativeEntry({ playthroughId: pt.id, role: 'system', kind: 'signal_input', content: 's1' });
      await playthroughService.appendNarrativeEntry({ playthroughId: pt.id, role: 'receive', kind: 'player_input', content: 'p1' });

      const reader = createNarrativeHistoryReader(pt.id);
      const narrativesOnly = await reader.readRecent({ limit: 10, kinds: ['narrative'] });
      expect(narrativesOnly).toHaveLength(1);
      expect(narrativesOnly[0]!.content).toBe('n1');

      const nonNarrative = await reader.readRecent({ limit: 10, kinds: ['signal_input', 'player_input'] });
      expect(nonNarrative).toHaveLength(2);
    });

    it('limit 生效', async () => {
      const pt = await createTestPlaythrough();
      for (let i = 0; i < 5; i++) {
        await playthroughService.appendNarrativeEntry({ playthroughId: pt.id, role: 'generate', content: `e${i}` });
      }
      const reader = createNarrativeHistoryReader(pt.id);
      const result = await reader.readRecent({ limit: 2 });
      expect(result).toHaveLength(2);
    });
  });

  describe('readRange', () => {
    it('按 orderIdx 闭区间过滤', async () => {
      const pt = await createTestPlaythrough();
      for (let i = 0; i < 5; i++) {
        await playthroughService.appendNarrativeEntry({ playthroughId: pt.id, role: 'generate', content: `e${i}` });
      }
      const reader = createNarrativeHistoryReader(pt.id);
      const r = await reader.readRange({ fromOrderIdx: 1, toOrderIdx: 3 });
      expect(r.map((e) => e.content)).toEqual(['e1', 'e2', 'e3']);
    });

    it('无约束 = 全部', async () => {
      const pt = await createTestPlaythrough();
      for (let i = 0; i < 3; i++) {
        await playthroughService.appendNarrativeEntry({ playthroughId: pt.id, role: 'generate', content: `e${i}` });
      }
      const reader = createNarrativeHistoryReader(pt.id);
      const r = await reader.readRange({});
      expect(r.length).toBe(3);
    });
  });
});
