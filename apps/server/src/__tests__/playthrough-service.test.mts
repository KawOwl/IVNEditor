/**
 * PlaythroughService tests
 *
 * These cover the playthrough metadata/state table after the legacy
 * narrative_entries protocol was removed. Runtime content history is covered by
 * core_event_envelopes tests.
 */

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { PlaythroughService } from '#internal/services/playthrough-service';
import { db, schema } from '#internal/db';
import { assertTestDatabase } from '#internal/__tests__/_db-guard';
import type { ScriptManifest } from '@ivn/core/types';
import { turnId, type CoreEvent } from '@ivn/core/game-session';

const service = new PlaythroughService();
const TEST_CHAPTER_ID = 'ch1';

async function cleanTables() {
  await assertTestDatabase();
  await db.delete(schema.coreEventEnvelopes);
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

function makeManifest(label: string): ScriptManifest {
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

async function createTestUser(): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(schema.users).values({ id });
  return id;
}

async function createTestScriptVersion(
  authorUserId: string,
  scriptKey = 'default',
): Promise<string> {
  const scriptId = `test-script-${scriptKey}-${crypto.randomUUID().slice(0, 8)}`;
  const versionId = `test-version-${scriptKey}-${crypto.randomUUID().slice(0, 8)}`;
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
    manifest: makeManifest(`test script ${scriptKey}`),
    contentHash: `hash-${versionId}`,
  });
  return versionId;
}

async function createTestPlaythrough(overrides: Partial<{
  userId: string;
  scriptVersionId: string;
  scriptKey: string;
  title: string;
  kind: 'production' | 'playtest';
  llmConfigId: string;
}> = {}) {
  const userId = overrides.userId ?? await createTestUser();
  const scriptVersionId = overrides.scriptVersionId
    ?? await createTestScriptVersion(userId, overrides.scriptKey ?? 'default');
  const llmConfigId = overrides.llmConfigId ?? await createTestLlmConfig();
  const created = await service.create({
    userId,
    scriptVersionId,
    chapterId: TEST_CHAPTER_ID,
    title: overrides.title,
    kind: overrides.kind,
    llmConfigId,
  });
  return { ...created, userId, scriptVersionId, llmConfigId };
}

beforeEach(async () => {
  await cleanTables();
});

afterAll(async () => {
  await cleanTables();
});

describe('PlaythroughService', () => {
  it('creates a playthrough with initial metadata and state', async () => {
    const pt = await createTestPlaythrough();

    expect(pt.id).toBeTruthy();
    expect(pt.title).toBe('游玩 #1');

    const detail = await service.getById(pt.id, pt.userId);
    expect(detail).not.toBeNull();
    expect(detail!.scriptVersionId).toBe(pt.scriptVersionId);
    expect(detail!.llmConfigId).toBe(pt.llmConfigId);
    expect(detail!.chapterId).toBe(TEST_CHAPTER_ID);
    expect(detail!.status).toBe('idle');
    expect(detail!.turn).toBe(0);
    expect(detail!.stateVars).toEqual({});
    expect(detail!.memorySnapshot).toBeNull();
  });

  it('increments generated titles per user and script version', async () => {
    const userId = await createTestUser();
    const scriptVersionId = await createTestScriptVersion(userId, 'shared');

    const first = await createTestPlaythrough({ userId, scriptVersionId });
    const second = await createTestPlaythrough({ userId, scriptVersionId });
    const otherUser = await createTestPlaythrough({ scriptVersionId });

    expect(first.title).toBe('游玩 #1');
    expect(second.title).toBe('游玩 #2');
    expect(otherUser.title).toBe('游玩 #1');
  });

  it('lists only the requested user and supports version/kind/archive filters', async () => {
    const userId = await createTestUser();
    const versionA = await createTestScriptVersion(userId, 'a');
    const versionB = await createTestScriptVersion(userId, 'b');

    const playtest = await createTestPlaythrough({
      userId,
      scriptVersionId: versionA,
      kind: 'playtest',
      title: 'A',
    });
    await createTestPlaythrough({
      userId,
      scriptVersionId: versionB,
      kind: 'production',
      title: 'B',
    });
    await createTestPlaythrough({ title: 'other-user' });

    await service.update(playtest.id, userId, { archived: true });

    expect(await service.list({ userId, scriptVersionId: versionA })).toHaveLength(0);
    expect(await service.list({ userId, scriptVersionIds: [versionA, versionB] }))
      .toHaveLength(1);

    const withArchived = await service.list({
      userId,
      scriptVersionIds: [versionA, versionB],
      kind: 'playtest',
      includeArchived: true,
    });
    expect(withArchived).toHaveLength(1);
    expect(withArchived[0]!.id).toBe(playtest.id);
  });

  it('enforces ownership for detail, update, and delete operations', async () => {
    const owner = await createTestPlaythrough({ title: 'owned' });
    const otherUserId = await createTestUser();

    expect(await service.getById(owner.id, otherUserId)).toBeNull();
    expect(await service.update(owner.id, otherUserId, { title: 'stolen' })).toBe(false);
    expect(await service.delete(owner.id, otherUserId)).toBe(false);

    const before = await service.getById(owner.id, owner.userId);
    expect(before!.title).toBe('owned');

    expect(await service.update(owner.id, owner.userId, { title: 'renamed' })).toBe(true);
    const afterUpdate = await service.getById(owner.id, owner.userId);
    expect(afterUpdate!.title).toBe('renamed');

    expect(await service.delete(owner.id, owner.userId)).toBe(true);
    expect(await service.getById(owner.id, owner.userId)).toBeNull();
  });

  it('updates runtime state fields without touching content history', async () => {
    const pt = await createTestPlaythrough();

    await service.updateState(pt.id, {
      status: 'waiting-input',
      turn: 2,
      stateVars: { chapter: 2 },
      memorySnapshot: { kind: 'test-memory', entries: 3 },
      inputHint: 'choose',
      inputType: 'choice',
      choices: ['A', 'B'],
      preview: 'latest preview',
      currentScene: {
        background: 'library',
        sprites: [{ id: 'luna', emotion: 'calm', position: 'center' }],
      },
      sentenceIndex: 12,
    });

    const detail = await service.getById(pt.id, pt.userId);
    expect(detail!.status).toBe('waiting-input');
    expect(detail!.turn).toBe(2);
    expect(detail!.stateVars).toEqual({ chapter: 2 });
    expect(detail!.memorySnapshot).toEqual({ kind: 'test-memory', entries: 3 });
    expect(detail!.inputHint).toBe('choose');
    expect(detail!.inputType).toBe('choice');
    expect(detail!.choices).toEqual(['A', 'B']);
    expect(detail!.preview).toBe('latest preview');
    expect(detail!.currentScene).toEqual({
      background: 'library',
      sprites: [{ id: 'luna', emotion: 'calm', position: 'center' }],
    });
    expect(detail!.sentenceIndex).toBe(12);
  });

  it('list 派生 preview：用最新 narrative-segment-finalized 现算，剥掉 scratch', async () => {
    const pt = await createTestPlaythrough({ title: 'derived' });

    await db.insert(schema.coreEventEnvelopes).values({
      id: crypto.randomUUID(),
      playthroughId: pt.id,
      schemaVersion: 1,
      sequence: 1,
      occurredAt: Date.now(),
      event: {
        type: 'narrative-segment-finalized',
        turnId: turnId(1),
        stepId: null,
        batchId: null,
        reason: 'generate-complete',
        entry: {
          role: 'generate',
          content:
            '<scratch>GM 内部思考：推进指数升到 3</scratch>' +
            '<narration>黄昏的教室里只剩下她一个人。</narration>',
          finishReason: 'stop',
        },
        sceneAfter: { background: null, sprites: [] },
      } satisfies CoreEvent,
    });

    // 模拟 DB column 里残留的污染 preview，验证被派生值覆盖
    await service.updateState(pt.id, { preview: 'GM 思考：推进指数升到 3...' });

    const list = await service.list({ userId: pt.userId });
    expect(list).toHaveLength(1);
    expect(list[0]!.preview).toBe('黄昏的教室里只剩下她一个人。');
  });

  it('list 派生 preview：无 narrative event → fallback 到 DB column', async () => {
    const pt = await createTestPlaythrough({ title: 'fallback' });
    await service.updateState(pt.id, { preview: 'legacy preview text' });

    const list = await service.list({ userId: pt.userId });
    expect(list).toHaveLength(1);
    expect(list[0]!.preview).toBe('legacy preview text');
  });

  it('list 派生 preview：多 turn 取最新 sequence 的 segment', async () => {
    const pt = await createTestPlaythrough({ title: 'multi-turn' });

    await db.insert(schema.coreEventEnvelopes).values([
      {
        id: crypto.randomUUID(),
        playthroughId: pt.id,
        schemaVersion: 1,
        sequence: 1,
        occurredAt: Date.now(),
        event: {
          type: 'narrative-segment-finalized',
          turnId: turnId(1),
          stepId: null,
          batchId: null,
          reason: 'generate-complete',
          entry: {
            role: 'generate',
            content: '<narration>第一轮的旧叙事。</narration>',
            finishReason: 'stop',
          },
          sceneAfter: { background: null, sprites: [] },
        } satisfies CoreEvent,
      },
      {
        id: crypto.randomUUID(),
        playthroughId: pt.id,
        schemaVersion: 1,
        sequence: 2,
        occurredAt: Date.now() + 1,
        event: {
          type: 'narrative-segment-finalized',
          turnId: turnId(2),
          stepId: null,
          batchId: null,
          reason: 'generate-complete',
          entry: {
            role: 'generate',
            content: '<narration>第二轮最新叙事。</narration>',
            finishReason: 'stop',
          },
          sceneAfter: { background: null, sprites: [] },
        } satisfies CoreEvent,
      },
    ]);

    const list = await service.list({ userId: pt.userId });
    expect(list).toHaveLength(1);
    expect(list[0]!.preview).toBe('第二轮最新叙事。');
  });
});
