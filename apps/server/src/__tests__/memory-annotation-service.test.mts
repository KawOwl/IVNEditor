/**
 * MemoryAnnotationService + MemoryRetrievalService 单元测试（ANN.1）
 *
 * 走真实 ivn_test DB（_db-guard 防误删生产）。每个 it 前清表。
 *
 * 覆盖：
 *  - retrieval 落库 / getById
 *  - markDeleted happy path（含 entry snapshot 持久化）
 *  - markDeleted 校验（retrieval 不存在 / entry 不在 retrieval.entries）
 *  - markDeleted idempotent（同 entry 重复标返同一行）
 *  - cancel 5s 内成功
 *  - cancel 5s 后 CancelWindowExpiredError
 *  - cancel 已撤销 / 不存在 → AnnotationNotFoundError
 *  - listActiveByPlaythrough 排除 cancelled 行
 *  - cancel 后允许同 entry 再次 markDeleted（unique partial index 语义）
 */

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, schema } from '#internal/db';
import { assertTestDatabase } from '#internal/__tests__/_db-guard';
import { PlaythroughService } from '#internal/services/playthrough-service';
import {
  memoryRetrievalService,
} from '#internal/services/memory-retrieval-service';
import {
  memoryAnnotationService,
  CANCEL_WINDOW_MS,
  CancelWindowExpiredError,
  RetrievalEntryNotFoundError,
  AnnotationNotFoundError,
} from '#internal/services/memory-annotation-service';
import type { ScriptManifest } from '@ivn/core/types';
import type { MemoryEntrySnapshot } from '#internal/db/schema';

const playthroughService = new PlaythroughService();

const TEST_CHAPTER_ID = 'ch1';

function makeMinimalManifest(): ScriptManifest {
  return {
    id: 'placeholder',
    label: 'test',
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

async function cleanTables() {
  await assertTestDatabase();
  // 删除顺序：annotations FK retrieval RESTRICT，所以 annotations 必须先删
  await db.delete(schema.memoryDeletionAnnotations);
  await db.delete(schema.turnMemoryRetrievals);
  // narrative_entries 已被 main 移除（取代为 core_event_envelopes 单一内容日志）
  await db.delete(schema.coreEventEnvelopes);
  await db.delete(schema.playthroughs);
  await db.delete(schema.scriptVersions);
  await db.delete(schema.scripts);
  await db.delete(schema.users);
  await db.delete(schema.llmConfigs);
}

async function setupPlaythrough(): Promise<{ playthroughId: string; userId: string }> {
  const userId = crypto.randomUUID();
  await db.insert(schema.users).values({ id: userId });
  const scriptId = `s-${crypto.randomUUID().slice(0, 6)}`;
  const versionId = `v-${crypto.randomUUID().slice(0, 6)}`;
  await db.insert(schema.scripts).values({ id: scriptId, authorUserId: userId, label: 'test' });
  await db.insert(schema.scriptVersions).values({
    id: versionId,
    scriptId,
    versionNumber: 1,
    status: 'draft',
    manifest: makeMinimalManifest(),
    contentHash: `h-${versionId}`,
  });
  const llmConfigId = crypto.randomUUID();
  await db.insert(schema.llmConfigs).values({
    id: llmConfigId,
    name: `t-${llmConfigId.slice(0, 6)}`,
    provider: 'openai-compatible',
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    model: 'm',
  });
  const pt = await playthroughService.create({
    scriptVersionId: versionId,
    chapterId: TEST_CHAPTER_ID,
    userId,
    llmConfigId,
  });
  return { playthroughId: pt.id, userId };
}

function makeEntry(id: string, content: string = 'memory content'): MemoryEntrySnapshot {
  return {
    id,
    turn: 1,
    role: 'generate',
    content,
    tokenCount: 5,
    timestamp: Date.now(),
  };
}

beforeEach(async () => {
  await cleanTables();
});

afterAll(async () => {
  await cleanTables();
});

describe('MemoryRetrievalService', () => {
  it('records and retrieves a turn memory retrieval', async () => {
    const { playthroughId } = await setupPlaythrough();
    const id = crypto.randomUUID();
    const entries = [makeEntry('e1', 'first'), makeEntry('e2', 'second')];

    await memoryRetrievalService.record({
      id,
      playthroughId,
      turn: 1,
      batchId: null,
      source: 'context-assembly',
      query: 'what just happened',
      entries,
      summary: 'first\nsecond',
      meta: { topK: 5 },
    });

    const row = await memoryRetrievalService.getById(id);
    expect(row).not.toBeNull();
    expect(row!.entries.length).toBe(2);
    expect(row!.entries[0]!.id).toBe('e1');
    expect(row!.summary).toBe('first\nsecond');
    expect(row!.meta).toEqual({ topK: 5 });
  });

  it('lists by playthrough filtered by turn', async () => {
    const { playthroughId } = await setupPlaythrough();
    for (let turn = 1; turn <= 3; turn++) {
      await memoryRetrievalService.record({
        id: crypto.randomUUID(),
        playthroughId,
        turn,
        batchId: null,
        source: 'context-assembly',
        query: '',
        entries: [makeEntry(`e-${turn}`)],
        summary: '',
      });
    }

    const all = await memoryRetrievalService.listByPlaythrough(playthroughId);
    expect(all.length).toBe(3);

    const turn2 = await memoryRetrievalService.listByPlaythrough(playthroughId, { turn: 2 });
    expect(turn2.length).toBe(1);
    expect(turn2[0]!.entries[0]!.id).toBe('e-2');
  });
});

describe('MemoryAnnotationService.markDeleted', () => {
  it('writes annotation row + persists entry snapshot', async () => {
    const { playthroughId } = await setupPlaythrough();
    const retrievalId = crypto.randomUUID();
    const entry = makeEntry('mem-1', 'this is the memory text');
    await memoryRetrievalService.record({
      id: retrievalId,
      playthroughId,
      turn: 1,
      batchId: null,
      source: 'context-assembly',
      query: '',
      entries: [entry],
      summary: '',
    });

    const annotation = await memoryAnnotationService.markDeleted({
      turnMemoryRetrievalId: retrievalId,
      memoryEntryId: 'mem-1',
      reasonCode: 'memory-confused',
    });

    expect(annotation.memoryEntryId).toBe('mem-1');
    expect(annotation.reasonCode).toBe('memory-confused');
    expect(annotation.cancelledAt).toBeNull();
    expect(annotation.memoryEntrySnapshot.content).toBe('this is the memory text');
  });

  it('throws RetrievalEntryNotFoundError when retrievalId missing', async () => {
    await expect(
      memoryAnnotationService.markDeleted({
        turnMemoryRetrievalId: 'nonexistent',
        memoryEntryId: 'mem-1',
        reasonCode: 'other',
      }),
    ).rejects.toBeInstanceOf(RetrievalEntryNotFoundError);
  });

  it('throws RetrievalEntryNotFoundError when entry not in retrieval.entries', async () => {
    const { playthroughId } = await setupPlaythrough();
    const retrievalId = crypto.randomUUID();
    await memoryRetrievalService.record({
      id: retrievalId,
      playthroughId,
      turn: 1,
      batchId: null,
      source: 'context-assembly',
      query: '',
      entries: [makeEntry('mem-1')],
      summary: '',
    });
    await expect(
      memoryAnnotationService.markDeleted({
        turnMemoryRetrievalId: retrievalId,
        memoryEntryId: 'mem-other',
        reasonCode: 'other',
      }),
    ).rejects.toBeInstanceOf(RetrievalEntryNotFoundError);
  });

  it('is idempotent: marking same entry twice returns same annotation row', async () => {
    const { playthroughId } = await setupPlaythrough();
    const retrievalId = crypto.randomUUID();
    await memoryRetrievalService.record({
      id: retrievalId,
      playthroughId,
      turn: 1,
      batchId: null,
      source: 'context-assembly',
      query: '',
      entries: [makeEntry('mem-1')],
      summary: '',
    });

    const a = await memoryAnnotationService.markDeleted({
      turnMemoryRetrievalId: retrievalId,
      memoryEntryId: 'mem-1',
      reasonCode: 'logic-error',
    });
    const b = await memoryAnnotationService.markDeleted({
      turnMemoryRetrievalId: retrievalId,
      memoryEntryId: 'mem-1',
      reasonCode: 'character-broken', // should be ignored — first wins
    });
    expect(b.id).toBe(a.id);
    expect(b.reasonCode).toBe('logic-error'); // 第一次的 reason 保留
  });
});

describe('MemoryAnnotationService.cancel', () => {
  it('cancels within 5s window', async () => {
    const { playthroughId } = await setupPlaythrough();
    const retrievalId = crypto.randomUUID();
    await memoryRetrievalService.record({
      id: retrievalId,
      playthroughId,
      turn: 1,
      batchId: null,
      source: 'context-assembly',
      query: '',
      entries: [makeEntry('mem-1')],
      summary: '',
    });
    const ann = await memoryAnnotationService.markDeleted({
      turnMemoryRetrievalId: retrievalId,
      memoryEntryId: 'mem-1',
      reasonCode: 'other',
    });

    const cancelled = await memoryAnnotationService.cancel(ann.id);
    expect(cancelled.cancelledAt).not.toBeNull();
  });

  it('rejects cancel after 5s window', async () => {
    const { playthroughId } = await setupPlaythrough();
    const retrievalId = crypto.randomUUID();
    await memoryRetrievalService.record({
      id: retrievalId,
      playthroughId,
      turn: 1,
      batchId: null,
      source: 'context-assembly',
      query: '',
      entries: [makeEntry('mem-1')],
      summary: '',
    });
    const ann = await memoryAnnotationService.markDeleted({
      turnMemoryRetrievalId: retrievalId,
      memoryEntryId: 'mem-1',
      reasonCode: 'other',
    });

    // 模拟时钟推进过 5s
    const future = new Date(ann.createdAt.getTime() + CANCEL_WINDOW_MS + 1);
    await expect(memoryAnnotationService.cancel(ann.id, future)).rejects.toBeInstanceOf(
      CancelWindowExpiredError,
    );
  });

  it('rejects cancel of nonexistent annotation', async () => {
    await expect(memoryAnnotationService.cancel('nonexistent')).rejects.toBeInstanceOf(
      AnnotationNotFoundError,
    );
  });

  it('rejects cancel of already-cancelled annotation', async () => {
    const { playthroughId } = await setupPlaythrough();
    const retrievalId = crypto.randomUUID();
    await memoryRetrievalService.record({
      id: retrievalId,
      playthroughId,
      turn: 1,
      batchId: null,
      source: 'context-assembly',
      query: '',
      entries: [makeEntry('mem-1')],
      summary: '',
    });
    const ann = await memoryAnnotationService.markDeleted({
      turnMemoryRetrievalId: retrievalId,
      memoryEntryId: 'mem-1',
      reasonCode: 'other',
    });
    await memoryAnnotationService.cancel(ann.id);
    await expect(memoryAnnotationService.cancel(ann.id)).rejects.toBeInstanceOf(
      AnnotationNotFoundError,
    );
  });
});

describe('MemoryAnnotationService.listActiveByPlaythrough', () => {
  it('returns active annotations only, excluding cancelled', async () => {
    const { playthroughId } = await setupPlaythrough();
    const retrievalId = crypto.randomUUID();
    await memoryRetrievalService.record({
      id: retrievalId,
      playthroughId,
      turn: 1,
      batchId: null,
      source: 'context-assembly',
      query: '',
      entries: [makeEntry('a'), makeEntry('b'), makeEntry('c')],
      summary: '',
    });

    const a = await memoryAnnotationService.markDeleted({
      turnMemoryRetrievalId: retrievalId,
      memoryEntryId: 'a',
      reasonCode: 'character-broken',
    });
    const b = await memoryAnnotationService.markDeleted({
      turnMemoryRetrievalId: retrievalId,
      memoryEntryId: 'b',
      reasonCode: 'logic-error',
    });
    await memoryAnnotationService.markDeleted({
      turnMemoryRetrievalId: retrievalId,
      memoryEntryId: 'c',
      reasonCode: 'memory-confused',
    });
    await memoryAnnotationService.cancel(a.id);
    void b;

    const active = await memoryAnnotationService.listActiveByPlaythrough(playthroughId);
    expect(active.length).toBe(2);
    const ids = active.map((d) => d.memoryEntryId).sort();
    expect(ids).toEqual(['b', 'c']);
  });

  it('allows re-marking the same entry after cancellation (partial unique index)', async () => {
    const { playthroughId } = await setupPlaythrough();
    const retrievalId = crypto.randomUUID();
    await memoryRetrievalService.record({
      id: retrievalId,
      playthroughId,
      turn: 1,
      batchId: null,
      source: 'context-assembly',
      query: '',
      entries: [makeEntry('mem-1')],
      summary: '',
    });
    const first = await memoryAnnotationService.markDeleted({
      turnMemoryRetrievalId: retrievalId,
      memoryEntryId: 'mem-1',
      reasonCode: 'other',
    });
    await memoryAnnotationService.cancel(first.id);
    const second = await memoryAnnotationService.markDeleted({
      turnMemoryRetrievalId: retrievalId,
      memoryEntryId: 'mem-1',
      reasonCode: 'logic-error',
    });
    expect(second.id).not.toBe(first.id);
    expect(second.reasonCode).toBe('logic-error');

    const all = await memoryAnnotationService.listAllByPlaythrough(playthroughId);
    expect(all.length).toBe(2);
  });
});
