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

const service = new PlaythroughService();

// ============================================================================
// Helpers
// ============================================================================

async function cleanTables() {
  await db.delete(schema.narrativeEntries);
  await db.delete(schema.playthroughs);
}

const TEST_SCRIPT_ID = 'test-script-persist';
const TEST_CHAPTER_ID = 'ch1';

async function createTestPlaythrough() {
  return service.create({
    scriptId: TEST_SCRIPT_ID,
    chapterId: TEST_CHAPTER_ID,
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

      const detail = await service.getById(pt.id);
      expect(detail!.status).toBe('generating');
      expect(detail!.turn).toBe(1);
    });

    it('should increment turn across calls', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      await persistence.onGenerateStart(1);
      await persistence.onGenerateStart(2);
      await persistence.onGenerateStart(3);

      const detail = await service.getById(pt.id);
      expect(detail!.turn).toBe(3);
    });
  });

  // --------------------------------------------------------------------------
  // onGenerateComplete
  // --------------------------------------------------------------------------

  describe('onGenerateComplete', () => {
    it('should save narrative entry and memory snapshot', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      const memoryEntries = [{ role: 'generate', content: 'hello', turn: 1 }];
      const memorySummaries = ['summary 1'];

      await persistence.onGenerateComplete({
        entry: {
          role: 'generate',
          content: '你站在草地上，四周一片寂静。',
          finishReason: 'stop',
        },
        memoryEntries,
        memorySummaries,
      });

      const detail = await service.getById(pt.id);
      // 检查 narrative entry
      expect(detail!.entries.length).toBe(1);
      expect(detail!.entries[0].role).toBe('generate');
      expect(detail!.entries[0].content).toBe('你站在草地上，四周一片寂静。');
      expect(detail!.entries[0].finishReason).toBe('stop');

      // 检查 memory 快照
      expect(detail!.memoryEntries).toEqual(memoryEntries);
      expect(detail!.memorySummaries).toEqual(memorySummaries);
    });

    it('should set preview from entry content', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      const longContent = '这是一段很长的叙事内容，' + '重复'.repeat(50);
      await persistence.onGenerateComplete({
        entry: { role: 'generate', content: longContent },
        memoryEntries: [],
        memorySummaries: [],
      });

      const detail = await service.getById(pt.id);
      expect(detail!.preview).toBeTruthy();
      expect(detail!.preview!.length).toBeLessThanOrEqual(80);
    });

    it('should not create entry for empty content', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      await persistence.onGenerateComplete({
        entry: { role: 'generate', content: '' },
        memoryEntries: [],
        memorySummaries: [],
      });

      const detail = await service.getById(pt.id);
      expect(detail!.entries.length).toBe(0);
    });

    it('should save reasoning and toolCalls', async () => {
      const pt = await createTestPlaythrough();
      const persistence = createPlaythroughPersistence(pt.id);

      await persistence.onGenerateComplete({
        entry: {
          role: 'generate',
          content: 'narrative text',
          reasoning: 'thinking about what to say...',
          toolCalls: [{ name: 'update_state', args: { key: 'trust', value: 2 } }],
          finishReason: 'tool_calls',
        },
        memoryEntries: [],
        memorySummaries: [],
      });

      const detail = await service.getById(pt.id);
      expect(detail!.entries[0].reasoning).toBe('thinking about what to say...');
      expect(detail!.entries[0].toolCalls).toEqual([{ name: 'update_state', args: { key: 'trust', value: 2 } }]);
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

      const detail = await service.getById(pt.id);
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

      const detail = await service.getById(pt.id);
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
      const memoryEntries = [
        { role: 'generate', content: 'narrative', turn: 1 },
        { role: 'receive', content: 'player action', turn: 1 },
      ];

      await persistence.onReceiveComplete({
        entry: { role: 'receive', content: '我走向那道光' },
        stateVars,
        turn: 1,
        memoryEntries,
        memorySummaries: [],
      });

      const detail = await service.getById(pt.id);
      // 检查 narrative entry
      expect(detail!.entries.length).toBe(1);
      expect(detail!.entries[0].role).toBe('receive');
      expect(detail!.entries[0].content).toBe('我走向那道光');

      // 检查状态更新
      expect(detail!.stateVars).toEqual(stateVars);
      expect(detail!.turn).toBe(1);
      expect(detail!.memoryEntries).toEqual(memoryEntries);

      // 检查输入状态清理
      expect(detail!.inputHint).toBeNull();
      expect(detail!.inputType).toBe('freetext');
      expect(detail!.choices).toBeNull();
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
      let detail = await service.getById(pt.id);
      expect(detail!.status).toBe('generating');
      expect(detail!.turn).toBe(1);

      // ② Generate 完成
      await persistence.onGenerateComplete({
        entry: { role: 'generate', content: '你醒来了，四周一片漆黑。' },
        memoryEntries: [{ role: 'generate', content: '你醒来了', turn: 1 }],
        memorySummaries: [],
      });
      detail = await service.getById(pt.id);
      expect(detail!.entries.length).toBe(1);
      expect(detail!.preview).toBeTruthy();

      // ③ 等待输入
      await persistence.onWaitingInput({
        hint: '你想做什么？',
        inputType: 'choice',
        choices: ['睁开眼睛', '继续装睡'],
      });
      detail = await service.getById(pt.id);
      expect(detail!.status).toBe('waiting-input');
      expect(detail!.choices).toEqual(['睁开眼睛', '继续装睡']);

      // ④ 玩家输入
      await persistence.onReceiveComplete({
        entry: { role: 'receive', content: '睁开眼睛' },
        stateVars: { awake: true },
        turn: 1,
        memoryEntries: [
          { role: 'generate', content: '你醒来了', turn: 1 },
          { role: 'receive', content: '睁开眼睛', turn: 1 },
        ],
        memorySummaries: [],
      });
      detail = await service.getById(pt.id);
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
      await persistence.onGenerateComplete({
        entry: { role: 'generate', content: 'Turn 1 narrative' },
        memoryEntries: [{ turn: 1, role: 'generate', content: 'Turn 1' }],
        memorySummaries: [],
      });
      await persistence.onWaitingInput({ hint: null, inputType: 'freetext', choices: null });
      await persistence.onReceiveComplete({
        entry: { role: 'receive', content: 'Player turn 1' },
        stateVars: { turn1done: true },
        turn: 1,
        memoryEntries: [
          { turn: 1, role: 'generate', content: 'Turn 1' },
          { turn: 1, role: 'receive', content: 'Player turn 1' },
        ],
        memorySummaries: [],
      });

      // Turn 2
      await persistence.onGenerateStart(2);
      await persistence.onGenerateComplete({
        entry: { role: 'generate', content: 'Turn 2 narrative' },
        memoryEntries: [
          { turn: 1, role: 'generate', content: 'Turn 1' },
          { turn: 1, role: 'receive', content: 'Player turn 1' },
          { turn: 2, role: 'generate', content: 'Turn 2' },
        ],
        memorySummaries: [],
      });

      const detail = await service.getById(pt.id);
      expect(detail!.turn).toBe(2);
      expect(detail!.entries.length).toBe(3); // gen1 + recv1 + gen2
      expect(detail!.entries[0].orderIdx).toBe(0);
      expect(detail!.entries[1].orderIdx).toBe(1);
      expect(detail!.entries[2].orderIdx).toBe(2);
      expect(detail!.stateVars).toEqual({ turn1done: true });
      expect(detail!.memoryEntries!.length).toBe(3);
    });
  });
});
