import { describe, expect, it } from 'bun:test';
import {
  batchId,
  createInputRequest,
  inputRequestId,
  turnId,
} from '#internal/game-session/core-events';
import {
  buildMessagesFromCoreEventHistory,
  projectCoreEventHistoryPage,
  projectCoreEventHistoryToMemoryEntries,
  type CoreEventHistoryItem,
} from '#internal/game-session/core-event-history';
import type { CoreEvent } from '#internal/game-session/core-events';

const emptyScene = { background: null, sprites: [] };

describe('CoreEvent history projection', () => {
  it('projects paginated readback sentences from ordered CoreEvents', () => {
    const page = projectCoreEventHistoryPage([
      item(3, {
        type: 'player-input-recorded',
        turnId: turnId(1),
        requestId: inputRequestId(1),
        batchId: batchId('receive-1')!,
        text: '前进',
        payload: { inputType: 'choice', selectedIndex: 0 },
        sentence: {
          kind: 'player_input',
          text: '前进',
          selectedIndex: 0,
          sceneRef: emptyScene,
          turnNumber: 1,
          index: 2,
        },
        snapshot: {
          turn: 1,
          stateVars: {},
          memorySnapshot: {},
          currentScene: emptyScene,
        },
      }),
      item(1, {
        type: 'narrative-batch-emitted',
        turnId: turnId(1),
        batchId: batchId('batch-1'),
        sentences: [{
          kind: 'narration',
          text: '雨停了。',
          sceneRef: emptyScene,
          bgChanged: false,
          spritesChanged: false,
          turnNumber: 1,
          index: 0,
        }],
        scratches: [],
        degrades: [],
        sceneAfter: emptyScene,
      }),
      item(2, {
        type: 'signal-input-recorded',
        turnId: turnId(1),
        batchId: batchId('batch-1'),
        request: createInputRequest('接下来？', ['前进']),
        sentence: {
          kind: 'signal_input',
          hint: '接下来？',
          choices: ['前进'],
          sceneRef: emptyScene,
          turnNumber: 1,
          index: 1,
        },
        sceneAfter: emptyScene,
      }),
    ], { offset: 1, limit: 2 });

    expect(page).toEqual({
      sentences: [
        {
          kind: 'signal_input',
          hint: '接下来？',
          choices: ['前进'],
          sceneRef: emptyScene,
          turnNumber: 1,
          index: 1,
        },
        {
          kind: 'player_input',
          text: '前进',
          selectedIndex: 0,
          sceneRef: emptyScene,
          turnNumber: 1,
          index: 2,
        },
      ],
      offset: 1,
      limit: 2,
      totalEntries: 3,
      hasMore: false,
      nextOffset: 3,
    });
  });

  it('builds recent model messages from CoreEvent content events', () => {
    const messages = buildMessagesFromCoreEventHistory([
      item(1, {
        type: 'narrative-segment-finalized',
        turnId: turnId(1),
        stepId: null,
        batchId: batchId('batch-1'),
        reason: 'generate-complete',
        entry: { role: 'generate', content: '旁白', reasoning: '思考', finishReason: 'stop' },
        sceneAfter: emptyScene,
      }),
      item(2, {
        type: 'tool-call-finished',
        turnId: turnId(1),
        stepId: null,
        batchId: batchId('batch-1'),
        toolName: 'update_state',
        input: { hp: 1 },
        output: { ok: true },
      }),
      item(3, {
        type: 'player-input-recorded',
        turnId: turnId(1),
        requestId: null,
        batchId: batchId('receive-1')!,
        text: '继续',
        payload: { inputType: 'freetext' },
        sentence: {
          kind: 'player_input',
          text: '继续',
          sceneRef: emptyScene,
          turnNumber: 1,
          index: 3,
        },
        snapshot: {
          turn: 1,
          stateVars: {},
          memorySnapshot: {},
          currentScene: emptyScene,
        },
      }),
    ]);

    expect(messages).toHaveLength(3);
    expect(messages[0]!.role).toBe('assistant');
    expect(messages[1]!.role).toBe('tool');
    expect(messages[2]).toEqual({ role: 'user', content: '继续' });
    expect(JSON.stringify(messages[0]!.content)).toContain('update_state');
  });

  it('projects compactable memory entries with CoreEvent sequence cursors', () => {
    const entries = projectCoreEventHistoryToMemoryEntries([
      item(10, {
        type: 'narrative-segment-finalized',
        turnId: turnId(2),
        stepId: null,
        batchId: batchId('batch-2'),
        reason: 'generate-complete',
        entry: { role: 'generate', content: '第二轮旁白' },
        sceneAfter: emptyScene,
      }),
      item(11, {
        type: 'player-input-recorded',
        turnId: turnId(2),
        requestId: null,
        batchId: batchId('receive-2')!,
        text: '玩家回答',
        payload: { inputType: 'freetext' },
        sentence: {
          kind: 'player_input',
          text: '玩家回答',
          sceneRef: emptyScene,
          turnNumber: 2,
          index: 11,
        },
        snapshot: {
          turn: 2,
          stateVars: {},
          memorySnapshot: {},
          currentScene: emptyScene,
        },
      }),
    ]);

    expect(entries.map(({ role, content, sequence, turn }) => ({
      role,
      content,
      sequence,
      turn,
    }))).toEqual([
      { role: 'generate', content: '第二轮旁白', sequence: 10, turn: 2 },
      { role: 'receive', content: '玩家回答', sequence: 11, turn: 2 },
    ]);
  });

  // 改进 B（2026-04-26）：narrative-rewrite 替换语义。trace 227cb1d0 暴露
  // signal-input-preflush 落库的 prose 段污染下一轮 history → 让 'rewrite-applied'
  // reason 作为权威段，同 turn 内其他 reason 投影时跳过。
  describe('rewrite-applied 替换语义', () => {
    it('messages-builder: 同 turn 内 preflush + rewrite-applied → 仅保留 rewrite-applied', () => {
      const messages = buildMessagesFromCoreEventHistory([
        // 主 step 输出 prose，被 signal_input preflush 落库
        item(1, {
          type: 'narrative-segment-finalized',
          turnId: turnId(4),
          stepId: null,
          batchId: batchId('batch-4-main'),
          reason: 'signal-input-preflush',
          entry: { role: 'generate', content: '原 prose 段（应被覆盖）' },
          sceneAfter: emptyScene,
        }),
        // rewrite 跑完后落库的整 turn 重写版
        item(2, {
          type: 'narrative-segment-finalized',
          turnId: turnId(4),
          stepId: null,
          batchId: batchId('batch-4-main'),
          reason: 'rewrite-applied',
          entry: { role: 'generate', content: '<narration>rewrite 后版本</narration>' },
          sceneAfter: emptyScene,
        }),
      ]);
      const assistantContent = JSON.stringify(messages[0]?.content ?? '');
      expect(assistantContent).toContain('rewrite 后版本');
      expect(assistantContent).not.toContain('原 prose 段');
    });

    it('memory-entries: 同 turn 内 preflush + rewrite-applied → 仅保留 rewrite-applied', () => {
      const entries = projectCoreEventHistoryToMemoryEntries([
        item(1, {
          type: 'narrative-segment-finalized',
          turnId: turnId(4),
          stepId: null,
          batchId: batchId('batch-4-main'),
          reason: 'signal-input-preflush',
          entry: { role: 'generate', content: '原 prose 段' },
          sceneAfter: emptyScene,
        }),
        item(2, {
          type: 'narrative-segment-finalized',
          turnId: turnId(4),
          stepId: null,
          batchId: batchId('batch-4-main'),
          reason: 'rewrite-applied',
          entry: { role: 'generate', content: '<narration>rewrite 版</narration>' },
          sceneAfter: emptyScene,
        }),
      ]);
      expect(entries.map((e) => e.content)).toEqual([
        '<narration>rewrite 版</narration>',
      ]);
    });

    it('rewrite-applied 不影响其他 turn 的 segment（只覆盖同 turn）', () => {
      const messages = buildMessagesFromCoreEventHistory([
        item(1, {
          type: 'narrative-segment-finalized',
          turnId: turnId(3),
          stepId: null,
          batchId: batchId('batch-3'),
          reason: 'generate-complete',
          entry: { role: 'generate', content: 'turn 3 内容' },
          sceneAfter: emptyScene,
        }),
        item(2, {
          type: 'narrative-segment-finalized',
          turnId: turnId(4),
          stepId: null,
          batchId: batchId('batch-4'),
          reason: 'rewrite-applied',
          entry: { role: 'generate', content: 'turn 4 rewrite 版' },
          sceneAfter: emptyScene,
        }),
      ]);
      const all = JSON.stringify(messages);
      expect(all).toContain('turn 3 内容');
      expect(all).toContain('turn 4 rewrite 版');
    });

    // 紧急回归（trace cc5a92fe，2026-04-26）：第一版改进 B 用
    // `reason !== 'rewrite-applied'` 一刀切跳过同 turn 其他 segment——把
    // step-reasoning（DeepSeek V4 thinking 模式的 reasoning_content 来源）
    // 也跳了，导致下一轮 main generate 时 DeepSeek API 报 400 "reasoning_content
    // in thinking mode must be passed back". 修复后跳的是 preflush + generate-complete
    // 这两类内容性 segment，step-reasoning 必须保留。
    it('messages-builder: rewrite-applied turn 内 step-reasoning segment 仍被保留（DeepSeek thinking）', () => {
      const messages = buildMessagesFromCoreEventHistory([
        // step 0 reasoning（thinking 模式 stub entry，content=''）
        item(1, {
          type: 'narrative-segment-finalized',
          turnId: turnId(2),
          stepId: null,
          batchId: batchId('batch-2-main'),
          reason: 'step-reasoning',
          entry: { role: 'generate', content: '', reasoning: 'step0 思考...' },
          sceneAfter: emptyScene,
        }),
        // step 1 reasoning
        item(2, {
          type: 'narrative-segment-finalized',
          turnId: turnId(2),
          stepId: null,
          batchId: batchId('batch-2-main'),
          reason: 'step-reasoning',
          entry: { role: 'generate', content: '', reasoning: 'step1 思考...' },
          sceneAfter: emptyScene,
        }),
        // 主路径输出 prose 被 preflush 落库
        item(3, {
          type: 'narrative-segment-finalized',
          turnId: turnId(2),
          stepId: null,
          batchId: batchId('batch-2-main'),
          reason: 'signal-input-preflush',
          entry: { role: 'generate', content: '原 prose 段（应被覆盖）' },
          sceneAfter: emptyScene,
        }),
        // rewrite 应用，落 rewrite-applied（reasoning 字段为空，因为 rewrite call 不产 reasoning）
        item(4, {
          type: 'narrative-segment-finalized',
          turnId: turnId(2),
          stepId: null,
          batchId: batchId('batch-2-main'),
          reason: 'rewrite-applied',
          entry: { role: 'generate', content: '<narration>rewrite 版</narration>' },
          sceneAfter: emptyScene,
        }),
      ]);
      const assistantContent = JSON.stringify(messages[0]?.content ?? '');
      // narrative：rewrite 版替代 prose 段
      expect(assistantContent).toContain('rewrite 版');
      expect(assistantContent).not.toContain('原 prose 段');
      // **关键**：step 0 / step 1 的 reasoning 必须**仍在** assistant message
      //（DeepSeek V4 thinking replay 要求）
      expect(assistantContent).toContain('step0 思考');
      expect(assistantContent).toContain('step1 思考');
    });

    it('memory-entries: rewrite-applied turn 内 step-reasoning content="" 被 truthy 过滤不进 memory', () => {
      const entries = projectCoreEventHistoryToMemoryEntries([
        item(1, {
          type: 'narrative-segment-finalized',
          turnId: turnId(2),
          stepId: null,
          batchId: batchId('batch-2'),
          reason: 'step-reasoning',
          entry: { role: 'generate', content: '', reasoning: 'thinking 内容' },
          sceneAfter: emptyScene,
        }),
        item(2, {
          type: 'narrative-segment-finalized',
          turnId: turnId(2),
          stepId: null,
          batchId: batchId('batch-2'),
          reason: 'rewrite-applied',
          entry: { role: 'generate', content: '<narration>rewrite 版</narration>' },
          sceneAfter: emptyScene,
        }),
      ]);
      expect(entries.map((e) => e.content)).toEqual([
        '<narration>rewrite 版</narration>',
      ]);
    });

    it('turn 没有 rewrite-applied → 所有 reason 段正常累加（向后兼容）', () => {
      const messages = buildMessagesFromCoreEventHistory([
        item(1, {
          type: 'narrative-segment-finalized',
          turnId: turnId(5),
          stepId: null,
          batchId: batchId('batch-5'),
          reason: 'signal-input-preflush',
          entry: { role: 'generate', content: 'pre' },
          sceneAfter: emptyScene,
        }),
        item(2, {
          type: 'narrative-segment-finalized',
          turnId: turnId(5),
          stepId: null,
          batchId: batchId('batch-5'),
          reason: 'generate-complete',
          entry: { role: 'generate', content: 'post' },
          sceneAfter: emptyScene,
        }),
      ]);
      // 没 rewrite-applied → 两段都进，按 batchId group 合并 narrativeText
      const all = JSON.stringify(messages);
      expect(all).toContain('pre');
      expect(all).toContain('post');
    });
  });
});

function item(sequence: number, event: CoreEvent): CoreEventHistoryItem {
  return {
    sequence,
    occurredAt: sequence,
    event,
  };
}
