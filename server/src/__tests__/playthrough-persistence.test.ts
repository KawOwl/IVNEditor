/**
 * PlaythroughPersistence 单元测试
 *
 * 测试 createPlaythroughPersistence 返回的 SessionPersistence 实现
 * 是否正确地将 GameSession 状态转换持久化到数据库。
 */

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { createPlaythroughPersistence } from '../services/playthrough-persistence';
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

function makeMinimalManifest(): ScriptManifest {
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

/** 为测试建一个 script + version，返回 versionId */
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
    manifest: makeMinimalManifest(),
    contentHash: `hash-${versionId}`,
  });
  return versionId;
}

async function createTestPlaythrough() {
  const userId = await createTestUser();
  const scriptVersionId = await createTestScriptVersion(userId);
  const llmConfigId = await createTestLlmConfig();
  const r = await service.create({
    scriptVersionId,
    chapterId: TEST_CHAPTER_ID,
    userId,
    llmConfigId,
  });
  return { ...r, userId, scriptVersionId };
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

describe('PlaythroughPersistence', () => {

  // --------------------------------------------------------------------------
  // onGenerateStart
  // --------------------------------------------------------------------------

  describe('onGenerateStart', () => {
    it('should update status to generating and set turn', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      await persistence.onGenerateStart(1);

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.status).toBe('generating');
      expect(detail!.turn).toBe(1);
    });

    it('should increment turn across calls', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      await persistence.onGenerateStart(1);
      await persistence.onGenerateStart(2);
      await persistence.onGenerateStart(3);

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.turn).toBe(3);
    });
  });

  // --------------------------------------------------------------------------
  // onNarrativeSegmentFinalized — 保存叙事段 + 更新 preview
  // --------------------------------------------------------------------------

  describe('onNarrativeSegmentFinalized', () => {
    it('should save narrative entry', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      await persistence.onNarrativeSegmentFinalized({
        entry: {
          role: 'generate',
          content: '你站在草地上，四周一片寂静。',
          finishReason: 'stop',
        },
      });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.entries.length).toBe(1);
      expect(detail!.entries[0].role).toBe('generate');
      expect(detail!.entries[0].content).toBe('你站在草地上，四周一片寂静。');
      expect(detail!.entries[0].finishReason).toBe('stop');
    });

    it('should set preview from entry content', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      const longContent = '这是一段很长的叙事内容，' + '重复'.repeat(50);
      await persistence.onNarrativeSegmentFinalized({
        entry: { role: 'generate', content: longContent },
      });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.preview).toBeTruthy();
      expect(detail!.preview!.length).toBeLessThanOrEqual(80);
    });

    it('should not create entry for empty content', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      await persistence.onNarrativeSegmentFinalized({
        entry: { role: 'generate', content: '' },
      });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.entries.length).toBe(0);
    });

    it('should save reasoning + default kind=narrative', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      await persistence.onNarrativeSegmentFinalized({
        entry: {
          role: 'generate',
          content: 'narrative text',
          reasoning: 'thinking about what to say...',
          finishReason: 'stop',
        },
      });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.entries[0].reasoning).toBe('thinking about what to say...');
      // 0010: onNarrativeSegmentFinalized 走默认 kind='narrative'，payload null
      expect(detail!.entries[0].kind).toBe('narrative');
      expect(detail!.entries[0].payload).toBeNull();
    });

    it('should append multiple segments in order', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      await persistence.onNarrativeSegmentFinalized({
        entry: { role: 'generate', content: '第一段叙事' },
      });
      await persistence.onNarrativeSegmentFinalized({
        entry: { role: 'generate', content: '第二段叙事' },
      });
      await persistence.onNarrativeSegmentFinalized({
        entry: { role: 'generate', content: '第三段叙事' },
      });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.entries.length).toBe(3);
      expect(detail!.entries[0].content).toBe('第一段叙事');
      expect(detail!.entries[1].content).toBe('第二段叙事');
      expect(detail!.entries[2].content).toBe('第三段叙事');
      expect(detail!.entries[0].orderIdx).toBe(0);
      expect(detail!.entries[1].orderIdx).toBe(1);
      expect(detail!.entries[2].orderIdx).toBe(2);
      // Preview reflects the LATEST segment
      expect(detail!.preview).toBe('第三段叙事');
    });
  });

  // --------------------------------------------------------------------------
  // onToolCallRecorded — 普通工具持久化（migration 0011 / PR-M1）
  // --------------------------------------------------------------------------

  describe('onToolCallRecorded', () => {
    it('写入 kind=tool_call + content=toolName + payload={input, output} + batchId', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);
      const batchId = crypto.randomUUID();

      await persistence.onToolCallRecorded!({
        toolName: 'update_state',
        input: { key: 'trust', value: 2 },
        output: { success: true, updated: ['trust'] },
        batchId,
      });

      const detail = await service.getById(pt.id, pt.userId);
      const e = detail!.entries[0]!;
      expect(e.role).toBe('system');
      expect(e.kind).toBe('tool_call');
      expect(e.content).toBe('update_state');
      expect(e.payload).toEqual({
        input: { key: 'trust', value: 2 },
        output: { success: true, updated: ['trust'] },
      });
      expect(e.batchId).toBe(batchId);
    });

    it('同 batchId 的多个 tool_call + narrative + signal_input 共享分组', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);
      const batchId = crypto.randomUUID();

      await persistence.onNarrativeSegmentFinalized({
        entry: { role: 'generate', content: '旁白。' },
        batchId,
      });
      await persistence.onToolCallRecorded!({
        toolName: 'update_state',
        input: { a: 1 },
        output: { ok: true },
        batchId,
      });
      await persistence.onToolCallRecorded!({
        toolName: 'change_scene',
        input: { bg: 'forest' },
        output: { ok: true },
        batchId,
      });
      await persistence.onSignalInputRecorded!({
        hint: '做什么？',
        choices: ['离开', '留下'],
        batchId,
      });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.entries.length).toBe(4);
      for (const e of detail!.entries) {
        expect(e.batchId).toBe(batchId);
      }
      expect(detail!.entries.map((e) => e.kind)).toEqual([
        'narrative',
        'tool_call',
        'tool_call',
        'signal_input',
      ]);
    });
  });

  // --------------------------------------------------------------------------
  // onSignalInputRecorded — signal_input_needed 事件化（migration 0010 / Step 2）
  // --------------------------------------------------------------------------

  describe('onSignalInputRecorded', () => {
    it('should append signal_input entry with hint + choices payload', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      await persistence.onSignalInputRecorded!({
        hint: '你想做什么？',
        choices: ['探索洞穴', '返回村庄', '休息一下'],
      });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.entries.length).toBe(1);
      const e = detail!.entries[0]!;
      expect(e.role).toBe('system');
      expect(e.kind).toBe('signal_input');
      expect(e.content).toBe('你想做什么？');
      expect(e.payload).toEqual({ choices: ['探索洞穴', '返回村庄', '休息一下'] });
    });

    it('should accept empty choices array (freetext signal)', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      await persistence.onSignalInputRecorded!({
        hint: '请自由输入你的想法',
        choices: [],
      });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.entries[0]!.payload).toEqual({ choices: [] });
    });

    it('should append signal_input and narrative entries in order', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      await persistence.onNarrativeSegmentFinalized({
        entry: { role: 'generate', content: '教室里一片寂静。' },
      });
      await persistence.onSignalInputRecorded!({
        hint: '你想做什么？',
        choices: ['离开', '留下'],
      });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.entries.length).toBe(2);
      expect(detail!.entries[0]!.kind).toBe('narrative');
      expect(detail!.entries[1]!.kind).toBe('signal_input');
      expect(detail!.entries[0]!.orderIdx).toBe(0);
      expect(detail!.entries[1]!.orderIdx).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // onGenerateComplete — 仅同步 memory（不再负责 entry）
  // --------------------------------------------------------------------------

  describe('onGenerateComplete', () => {
    it('should sync memory snapshot', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      const memorySnapshot = {
        kind: 'legacy-v1',
        entries: [{ role: 'generate', content: 'hello', turn: 1 }],
        summaries: ['summary 1'],
      };

      await persistence.onGenerateComplete({ memorySnapshot });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.memorySnapshot).toEqual(memorySnapshot);
    });

    it('should not create any narrative entries', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      await persistence.onGenerateComplete({
        memorySnapshot: { kind: 'legacy-v1', entries: [], summaries: [] },
      });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.entries.length).toBe(0);
    });

    it('should update preview when provided', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      await persistence.onGenerateComplete({
        memorySnapshot: { kind: 'legacy-v1', entries: [], summaries: [] },
        preview: '自定义 preview',
      });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.preview).toBe('自定义 preview');
    });
  });

  // --------------------------------------------------------------------------
  // onWaitingInput
  // --------------------------------------------------------------------------

  describe('onWaitingInput', () => {
    it('should update status and choices for choice mode', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      await persistence.onWaitingInput({
        hint: '你想做什么？',
        inputType: 'choice',
        choices: ['走过去', '跑过去', '留在原地'],
      });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.status).toBe('waiting-input');
      expect(detail!.inputHint).toBe('你想做什么？');
      expect(detail!.inputType).toBe('choice');
      expect(detail!.choices).toEqual(['走过去', '跑过去', '留在原地']);
    });

    it('should update status for freetext mode', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      await persistence.onWaitingInput({
        hint: null,
        inputType: 'freetext',
        choices: null,
      });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.status).toBe('waiting-input');
      expect(detail!.inputHint).toBeNull();
      expect(detail!.choices).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // onReceiveComplete
  // --------------------------------------------------------------------------

  describe('onReceiveComplete', () => {
    it('should save player entry and update state', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      const stateVars = { trust: 2, explored: ['forest'] };
      const memorySnapshot = {
        kind: 'legacy-v1',
        entries: [
          { role: 'generate', content: 'narrative', turn: 1 },
          { role: 'receive', content: 'player action', turn: 1 },
        ],
        summaries: [],
      };

      await persistence.onReceiveComplete({
        entry: { role: 'receive', content: '我走向那道光' },
        stateVars,
        turn: 1,
        memorySnapshot,
      });

      const detail = await service.getById(pt.id, pt.userId);
      // 检查 narrative entry
      expect(detail!.entries.length).toBe(1);
      expect(detail!.entries[0].role).toBe('receive');
      expect(detail!.entries[0].content).toBe('我走向那道光');
      // migration 0010: player_input entry 默认 kind='player_input'
      expect(detail!.entries[0].kind).toBe('player_input');

      // 检查状态更新
      expect(detail!.stateVars).toEqual(stateVars);
      expect(detail!.turn).toBe(1);
      expect(detail!.memorySnapshot).toEqual(memorySnapshot);

      // 检查输入状态清理
      expect(detail!.inputHint).toBeNull();
      expect(detail!.inputType).toBe('freetext');
      expect(detail!.choices).toBeNull();
    });

    it('should persist payload.selectedIndex when player picked a choice', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      await persistence.onReceiveComplete({
        entry: { role: 'receive', content: '返回村庄' },
        stateVars: {},
        turn: 1,
        memorySnapshot: { kind: 'legacy-v1', entries: [], summaries: [] },
        payload: { inputType: 'choice', selectedIndex: 1 },
      });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.entries[0].payload).toEqual({
        inputType: 'choice',
        selectedIndex: 1,
      });
    });

    it('should persist payload.inputType=freetext when no choices', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      await persistence.onReceiveComplete({
        entry: { role: 'receive', content: '我自己写的一段回复' },
        stateVars: {},
        turn: 1,
        memorySnapshot: { kind: 'legacy-v1', entries: [], summaries: [] },
        payload: { inputType: 'freetext' },
      });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.entries[0].payload).toEqual({ inputType: 'freetext' });
    });

    it('should persist batchId when provided (migration 0011)', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);
      const batchId = crypto.randomUUID();

      await persistence.onReceiveComplete({
        entry: { role: 'receive', content: '返回村庄' },
        stateVars: {},
        turn: 1,
        memorySnapshot: { kind: 'legacy-v1', entries: [], summaries: [] },
        payload: { inputType: 'choice', selectedIndex: 1 },
        batchId,
      });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.entries[0].batchId).toBe(batchId);
      expect(detail!.entries[0].kind).toBe('player_input');
    });
  });

  // --------------------------------------------------------------------------
  // Full lifecycle simulation
  // --------------------------------------------------------------------------

  describe('full lifecycle', () => {
    it('should persist a complete turn (generate → waiting → receive)', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      // ① Generate 开始
      await persistence.onGenerateStart(1);
      let detail = await service.getById(pt.id, pt.userId);
      expect(detail!.status).toBe('generating');
      expect(detail!.turn).toBe(1);

      // ② 叙事段 finalize（一段 narrative）
      await persistence.onNarrativeSegmentFinalized({
        entry: { role: 'generate', content: '你醒来了，四周一片漆黑。' },
      });

      // ③ Generate 结束同步 memory
      await persistence.onGenerateComplete({
        memorySnapshot: {
          kind: 'legacy-v1',
          entries: [{ role: 'generate', content: '你醒来了', turn: 1 }],
          summaries: [],
        },
      });
      detail = await service.getById(pt.id, pt.userId);
      expect(detail!.entries.length).toBe(1);
      expect(detail!.preview).toBeTruthy();

      // ④ 等待输入
      await persistence.onWaitingInput({
        hint: '你想做什么？',
        inputType: 'choice',
        choices: ['睁开眼睛', '继续装睡'],
      });
      detail = await service.getById(pt.id, pt.userId);
      expect(detail!.status).toBe('waiting-input');
      expect(detail!.choices).toEqual(['睁开眼睛', '继续装睡']);

      // ⑤ 玩家输入
      await persistence.onReceiveComplete({
        entry: { role: 'receive', content: '睁开眼睛' },
        stateVars: { awake: true },
        turn: 1,
        memorySnapshot: {
          kind: 'legacy-v1',
          entries: [
            { role: 'generate', content: '你醒来了', turn: 1 },
            { role: 'receive', content: '睁开眼睛', turn: 1 },
          ],
          summaries: [],
        },
      });
      detail = await service.getById(pt.id, pt.userId);
      expect(detail!.entries.length).toBe(2);
      expect(detail!.entries[0].role).toBe('generate');
      expect(detail!.entries[1].role).toBe('receive');
      expect(detail!.stateVars).toEqual({ awake: true });
      expect(detail!.inputHint).toBeNull();
      expect(detail!.choices).toBeNull();
    });

    it('should persist multiple turns correctly', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      // Turn 1
      await persistence.onGenerateStart(1);
      await persistence.onNarrativeSegmentFinalized({
        entry: { role: 'generate', content: 'Turn 1 narrative' },
      });
      await persistence.onGenerateComplete({
        memorySnapshot: {
          kind: 'legacy-v1',
          entries: [{ turn: 1, role: 'generate', content: 'Turn 1' }],
          summaries: [],
        },
      });
      await persistence.onWaitingInput({ hint: null, inputType: 'freetext', choices: null });
      await persistence.onReceiveComplete({
        entry: { role: 'receive', content: 'Player turn 1' },
        stateVars: { turn1done: true },
        turn: 1,
        memorySnapshot: {
          kind: 'legacy-v1',
          entries: [
            { turn: 1, role: 'generate', content: 'Turn 1' },
            { turn: 1, role: 'receive', content: 'Player turn 1' },
          ],
          summaries: [],
        },
      });

      // Turn 2
      await persistence.onGenerateStart(2);
      await persistence.onNarrativeSegmentFinalized({
        entry: { role: 'generate', content: 'Turn 2 narrative' },
      });
      await persistence.onGenerateComplete({
        memorySnapshot: {
          kind: 'legacy-v1',
          entries: [
            { turn: 1, role: 'generate', content: 'Turn 1' },
            { turn: 1, role: 'receive', content: 'Player turn 1' },
            { turn: 2, role: 'generate', content: 'Turn 2' },
          ],
          summaries: [],
        },
      });

      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.turn).toBe(2);
      expect(detail!.entries.length).toBe(3); // gen1 + recv1 + gen2
      expect(detail!.entries[0].orderIdx).toBe(0);
      expect(detail!.entries[1].orderIdx).toBe(1);
      expect(detail!.entries[2].orderIdx).toBe(2);
      expect(detail!.stateVars).toEqual({ turn1done: true });
      expect((detail!.memorySnapshot?.entries as unknown[]).length).toBe(3);
    });

    it('should persist narrative when signal_input_needed suspends mid-generate', async () => {
      // 模拟真实场景：LLM 生成叙事 → 调 signal_input_needed 挂起
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      // ① generate 开始
      await persistence.onGenerateStart(1);

      // ② LLM 生成了一段叙事后调用 signal_input_needed
      //    GameSession 在挂起前会先 finalize 当前 narrative segment
      await persistence.onNarrativeSegmentFinalized({
        entry: { role: 'generate', content: '三个黑帮成员围住了你。' },
      });

      // ③ 持久化 waiting-input 状态（signal_input_needed 触发）
      await persistence.onWaitingInput({
        hint: '你想怎么做？',
        inputType: 'choice',
        choices: ['交涉', '逃跑', '动手'],
      });

      // 此时即使玩家关闭浏览器，DB 中也已经有完整的叙事 + choices
      const detail = await service.getById(pt.id, pt.userId);
      expect(detail!.entries.length).toBe(1);
      expect(detail!.entries[0].content).toBe('三个黑帮成员围住了你。');
      expect(detail!.status).toBe('waiting-input');
      expect(detail!.choices).toEqual(['交涉', '逃跑', '动手']);
      expect(detail!.preview).toBeTruthy();
    });
  });
});
