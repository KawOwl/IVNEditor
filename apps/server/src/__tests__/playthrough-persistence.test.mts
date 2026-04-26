/**
 * PlaythroughPersistence tests
 *
 * Persistence now writes playthrough state fields only; content history is
 * written through CoreEvent sinks into core_event_envelopes.
 */

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { createPlaythroughPersistence } from '#internal/services/playthrough-persistence';
import { PlaythroughService } from '#internal/services/playthrough-service';
import { db, schema } from '#internal/db';
import { assertTestDatabase } from '#internal/__tests__/_db-guard';
import type { ScriptManifest } from '@ivn/core/types';

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

function makeManifest(): ScriptManifest {
  return {
    id: 'placeholder',
    label: 'test script',
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

async function createTestScriptVersion(authorUserId: string): Promise<string> {
  const scriptId = `test-script-${crypto.randomUUID().slice(0, 8)}`;
  const versionId = `test-version-${crypto.randomUUID().slice(0, 8)}`;
  await db.insert(schema.scripts).values({
    id: scriptId,
    authorUserId,
    label: 'test script',
  });
  await db.insert(schema.scriptVersions).values({
    id: versionId,
    scriptId,
    versionNumber: 1,
    status: 'draft',
    manifest: makeManifest(),
    contentHash: `hash-${versionId}`,
  });
  return versionId;
}

async function createTestPlaythrough() {
  const userId = await createTestUser();
  const scriptVersionId = await createTestScriptVersion(userId);
  const llmConfigId = await createTestLlmConfig();
  const created = await service.create({
    userId,
    scriptVersionId,
    chapterId: TEST_CHAPTER_ID,
    llmConfigId,
  });
  return { ...created, userId, scriptVersionId };
}

beforeEach(async () => {
  await cleanTables();
});

afterAll(async () => {
  await cleanTables();
});

describe('PlaythroughPersistence', () => {
  it('persists generate start turn and status', async () => {
    const pt = await createTestPlaythrough();
    const persistence = createPlaythroughPersistence(pt.id);

    await persistence.onGenerateStart(3);

    const detail = await service.getById(pt.id, pt.userId);
    expect(detail!.status).toBe('generating');
    expect(detail!.turn).toBe(3);
  });

  it('persists generate completion snapshot, preview, and current scene', async () => {
    const pt = await createTestPlaythrough();
    const persistence = createPlaythroughPersistence(pt.id);

    await persistence.onGenerateComplete({
      memorySnapshot: { kind: 'memory', count: 2 },
      preview: 'preview from core events',
      currentScene: {
        background: 'archive',
        sprites: [{ id: 'luna', emotion: 'focused', position: 'left' }],
      },
    });

    const detail = await service.getById(pt.id, pt.userId);
    expect(detail!.memorySnapshot).toEqual({ kind: 'memory', count: 2 });
    expect(detail!.preview).toBe('preview from core events');
    expect(detail!.currentScene).toEqual({
      background: 'archive',
      sprites: [{ id: 'luna', emotion: 'focused', position: 'left' }],
    });
  });

  it('persists waiting input state and optional restore fields', async () => {
    const pt = await createTestPlaythrough();
    const persistence = createPlaythroughPersistence(pt.id);

    await persistence.onWaitingInput({
      hint: 'Pick a door',
      inputType: 'choice',
      choices: ['North', 'South'],
      memorySnapshot: { kind: 'memory', pending: true },
      currentScene: {
        background: 'hall',
        sprites: [{ id: 'guide', emotion: 'neutral', position: 'right' }],
      },
      stateVars: { doorSeen: true },
    });

    const detail = await service.getById(pt.id, pt.userId);
    expect(detail!.status).toBe('waiting-input');
    expect(detail!.inputHint).toBe('Pick a door');
    expect(detail!.inputType).toBe('choice');
    expect(detail!.choices).toEqual(['North', 'South']);
    expect(detail!.memorySnapshot).toEqual({ kind: 'memory', pending: true });
    expect(detail!.stateVars).toEqual({ doorSeen: true });
    expect(detail!.currentScene).toEqual({
      background: 'hall',
      sprites: [{ id: 'guide', emotion: 'neutral', position: 'right' }],
    });
  });

  it('persists receive completion and clears pending input fields', async () => {
    const pt = await createTestPlaythrough();
    const persistence = createPlaythroughPersistence(pt.id);

    await persistence.onWaitingInput({
      hint: 'Pick',
      inputType: 'choice',
      choices: ['A'],
    });
    await persistence.onReceiveComplete({
      stateVars: { trust: 1 },
      turn: 4,
      memorySnapshot: { kind: 'memory', afterInput: true },
    });

    const detail = await service.getById(pt.id, pt.userId);
    expect(detail!.status).toBe('idle');
    expect(detail!.turn).toBe(4);
    expect(detail!.stateVars).toEqual({ trust: 1 });
    expect(detail!.memorySnapshot).toEqual({ kind: 'memory', afterInput: true });
    expect(detail!.inputHint).toBeNull();
    expect(detail!.inputType).toBe('freetext');
    expect(detail!.choices).toBeNull();
  });

  it('persists finished state and terminal preview', async () => {
    const pt = await createTestPlaythrough();
    const persistence = createPlaythroughPersistence(pt.id);

    await persistence.onWaitingInput({
      hint: 'Pick',
      inputType: 'choice',
      choices: ['A'],
    });
    await persistence.onScenarioFinished?.({ reason: 'The archive closes.' });

    const detail = await service.getById(pt.id, pt.userId);
    expect(detail!.status).toBe('finished');
    expect(detail!.inputHint).toBeNull();
    expect(detail!.inputType).toBe('freetext');
    expect(detail!.choices).toBeNull();
    expect(detail!.preview).toBe('[完] The archive closes.');
  });
});
