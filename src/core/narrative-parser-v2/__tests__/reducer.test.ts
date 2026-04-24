/**
 * reducer.ts — 纯函数单测
 *
 * 直接用合成的 ParserEvent 序列驱动 reduce()，不经过 htmlparser2。
 * 覆盖 RFC §4.3 每条 silent tolerance 降级 + `<scratch>` 出口。
 */

import { describe, it, expect } from 'bun:test';
import type { SceneState } from '../../types';
import { reduce, type ParserEvent } from '../reducer';
import {
  initialParserState,
  type ParserManifest,
  type ParserState,
  type ReducerOutputs,
} from '../state';

// ============================================================================
// Fixtures
// ============================================================================

const MANIFEST: ParserManifest = {
  characters: new Set(['sakuya', 'karina', 'mc']),
  moodsByChar: new Map([
    ['sakuya', new Set(['neutral', 'smile', 'worried'])],
    ['karina', new Set(['serious', 'smile'])],
    ['mc', new Set(['neutral'])],
  ]),
  backgrounds: new Set(['cafe_interior', 'plaza_day']),
};

const INITIAL_SCENE: SceneState = { background: null, sprites: [] };

function makeInitial(turnNumber = 1, startIndex = 0): ParserState {
  return initialParserState({
    turnNumber,
    startIndex,
    initialScene: INITIAL_SCENE,
  });
}

/**
 * 声明式运行一串事件，返回最后的 state + 累积 outputs。
 * 纯函数组合，不碰原 state。
 */
function run(
  events: ReadonlyArray<ParserEvent>,
  manifest: ParserManifest = MANIFEST,
  init: ParserState = makeInitial(),
): { state: ParserState; outputs: ReducerOutputs } {
  return events.reduce<{ state: ParserState; outputs: ReducerOutputs }>(
    (acc, ev) => {
      const step = reduce(acc.state, ev, manifest);
      return {
        state: step.state,
        outputs: {
          sentences: [...acc.outputs.sentences, ...step.outputs.sentences],
          scratches: [...acc.outputs.scratches, ...step.outputs.scratches],
          degrades: [...acc.outputs.degrades, ...step.outputs.degrades],
        },
      };
    },
    { state: init, outputs: { sentences: [], scratches: [], degrades: [] } },
  );
}

// ============================================================================
// 基础顶层容器产出
// ============================================================================

describe('reduce · dialogue 容器', () => {
  it('完整 <dialogue speaker="sakuya">hi</dialogue> → 合法 dialogue sentence', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'dialogue', attrs: { speaker: 'sakuya' } },
      { type: 'text', data: 'hello world' },
      { type: 'closetag', name: 'dialogue' },
    ]);
    expect(outputs.sentences).toHaveLength(1);
    const s = outputs.sentences[0]!;
    expect(s.kind).toBe('dialogue');
    if (s.kind === 'dialogue') {
      expect(s.pf.speaker).toBe('sakuya');
      expect(s.text).toBe('hello world');
      expect(s.index).toBe(0);
    }
    expect(outputs.degrades).toHaveLength(0);
  });

  it('<dialogue> 缺 speaker → 降级 narration + degrade', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'dialogue', attrs: {} },
      { type: 'text', data: 'mystery text' },
      { type: 'closetag', name: 'dialogue' },
    ]);
    expect(outputs.sentences).toHaveLength(1);
    expect(outputs.sentences[0]!.kind).toBe('narration');
    expect(outputs.degrades).toMatchObject([{ code: 'dialogue-missing-speaker' }]);
  });

  it('<dialogue> speaker 不在白名单 → 保留 dialogue + degrade', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'dialogue', attrs: { speaker: 'ghost' } },
      { type: 'text', data: 'boo' },
      { type: 'closetag', name: 'dialogue' },
    ]);
    expect(outputs.sentences).toHaveLength(1);
    expect(outputs.sentences[0]!.kind).toBe('dialogue');
    expect(outputs.degrades).toMatchObject([
      { code: 'dialogue-unknown-speaker', detail: 'ghost' },
    ]);
  });

  it('<dialogue speaker=" "> 视为 missing', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'dialogue', attrs: { speaker: '   ' } },
      { type: 'text', data: 'x' },
      { type: 'closetag', name: 'dialogue' },
    ]);
    expect(outputs.sentences[0]!.kind).toBe('narration');
    expect(outputs.degrades[0]!.code).toBe('dialogue-missing-speaker');
  });

  it('<dialogue to="karina,mc" hear="*"> 解析 participation frame', () => {
    const { outputs } = run([
      {
        type: 'opentag',
        name: 'dialogue',
        attrs: { speaker: 'sakuya', to: 'karina, mc', hear: '*' },
      },
      { type: 'text', data: 'listen up' },
      { type: 'closetag', name: 'dialogue' },
    ]);
    const s = outputs.sentences[0]!;
    if (s.kind !== 'dialogue') throw new Error('expected dialogue');
    expect(s.pf.addressee).toEqual(['karina', 'mc']);
    expect(s.pf.overhearers).toEqual(['*']);
  });
});

describe('reduce · narration 容器', () => {
  it('完整 <narration> → narration sentence', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: '阳光透过窗户。' },
      { type: 'closetag', name: 'narration' },
    ]);
    expect(outputs.sentences).toHaveLength(1);
    expect(outputs.sentences[0]!.kind).toBe('narration');
    expect(outputs.sentences[0]!.text).toBe('阳光透过窗户。');
    expect(outputs.degrades).toHaveLength(0);
  });

  it('多个文本 chunk 累积到同一 textBuffer', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: 'part1-' },
      { type: 'text', data: 'part2' },
      { type: 'closetag', name: 'narration' },
    ]);
    expect(outputs.sentences[0]!.text).toBe('part1-part2');
  });
});

// ============================================================================
// 裸文本 / 未知顶层标签
// ============================================================================

describe('reduce · 容器外', () => {
  it('纯空白裸文本 → finalize 时静默丢弃，无 sentence 无 degrade', () => {
    const { outputs } = run([
      { type: 'text', data: '\n   \t  \n' },
      { type: 'finalize' },
    ]);
    expect(outputs.sentences).toHaveLength(0);
    expect(outputs.degrades).toHaveLength(0);
  });

  it('非空白裸文本 → finalize 时合并为单条 degrade，不产 sentence', () => {
    const { outputs } = run([
      { type: 'text', data: 'lost text here' },
      { type: 'finalize' },
    ]);
    expect(outputs.sentences).toHaveLength(0);
    expect(outputs.degrades).toMatchObject([
      { code: 'bare-text-outside-container', detail: 'lost text here' },
    ]);
  });

  it('多个 chunk 的裸文本 → 只合成一条 degrade（对抗 CJK 逐字 chunk）', () => {
    const { outputs } = run([
      { type: 'text', data: '我先' },
      { type: 'text', data: '查' },
      { type: 'text', data: '一下' },
      { type: 'text', data: '状态。' },
      { type: 'finalize' },
    ]);
    expect(outputs.sentences).toHaveLength(0);
    const bare = outputs.degrades.filter(
      (d) => d.code === 'bare-text-outside-container',
    );
    expect(bare).toHaveLength(1);
    expect(bare[0]!.detail).toBe('我先查一下状态。');
  });

  it('容器前的裸文本 → opentag 时 flush 成一条 degrade，正文正常', () => {
    const { outputs } = run([
      { type: 'text', data: '先写点 meta：' },
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: '正文' },
      { type: 'closetag', name: 'narration' },
    ]);
    const bare = outputs.degrades.filter(
      (d) => d.code === 'bare-text-outside-container',
    );
    expect(bare).toHaveLength(1);
    expect(bare[0]!.detail).toBe('先写点 meta：');
    expect(outputs.sentences).toHaveLength(1);
    expect(outputs.sentences[0]!.kind).toBe('narration');
    expect(outputs.sentences[0]!.text).toBe('正文');
  });

  it('容器之间的裸文本 → 也合并成一条 degrade', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: 'a' },
      { type: 'closetag', name: 'narration' },
      { type: 'text', data: '中间的' },
      { type: 'text', data: '裸文本' },
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: 'b' },
      { type: 'closetag', name: 'narration' },
    ]);
    expect(outputs.sentences).toHaveLength(2);
    const bare = outputs.degrades.filter(
      (d) => d.code === 'bare-text-outside-container',
    );
    expect(bare).toHaveLength(1);
    expect(bare[0]!.detail).toBe('中间的裸文本');
  });

  it('未知顶层 tag → degrade，其内部全部吞掉', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'foobar', attrs: {} },
      { type: 'text', data: '这段应该被吞掉' },
      { type: 'opentag', name: 'nested', attrs: {} },
      { type: 'text', data: '也吞' },
      { type: 'closetag', name: 'nested' },
      { type: 'closetag', name: 'foobar' },
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: '这段正常' },
      { type: 'closetag', name: 'narration' },
    ]);
    expect(outputs.sentences).toHaveLength(1);
    expect(outputs.sentences[0]!.text).toBe('这段正常');
    expect(outputs.degrades).toMatchObject([
      { code: 'unknown-toplevel-tag', detail: 'foobar' },
    ]);
  });
});

// ============================================================================
// 视觉子标签
// ============================================================================

describe('reduce · visual child tags', () => {
  it('<background scene="plaza_day"/> 更新 bg', () => {
    const { state, outputs } = run([
      { type: 'opentag', name: 'dialogue', attrs: { speaker: 'sakuya' } },
      { type: 'opentag', name: 'background', attrs: { scene: 'plaza_day' } },
      { type: 'closetag', name: 'background' },
      { type: 'text', data: 'outdoors' },
      { type: 'closetag', name: 'dialogue' },
    ]);
    expect(state.lastScene.background).toBe('plaza_day');
    const s = outputs.sentences[0]!;
    expect(s.bgChanged).toBe(true);
  });

  it('<background/> 缺 scene → degrade', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'opentag', name: 'background', attrs: {} },
      { type: 'closetag', name: 'background' },
      { type: 'text', data: 'x' },
      { type: 'closetag', name: 'narration' },
    ]);
    expect(outputs.degrades).toMatchObject([
      { code: 'bg-missing-attr', detail: 'scene' },
    ]);
  });

  it('<sprite/> 缺必填 → bg-missing-attr... 实际是 sprite-missing-attr', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      {
        type: 'opentag',
        name: 'sprite',
        attrs: { char: 'sakuya' }, // 缺 mood + position
      },
      { type: 'closetag', name: 'sprite' },
      { type: 'text', data: 'x' },
      { type: 'closetag', name: 'narration' },
    ]);
    expect(outputs.degrades).toHaveLength(1);
    expect(outputs.degrades[0]!.code).toBe('sprite-missing-attr');
    expect(outputs.degrades[0]!.detail).toContain('mood');
    expect(outputs.degrades[0]!.detail).toContain('position');
  });

  it('<sprite position="bottom"/> 非法位置 → drop + degrade', () => {
    const { state, outputs } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      {
        type: 'opentag',
        name: 'sprite',
        attrs: { char: 'sakuya', mood: 'smile', position: 'bottom' },
      },
      { type: 'closetag', name: 'sprite' },
      { type: 'text', data: 'x' },
      { type: 'closetag', name: 'narration' },
    ]);
    expect(state.lastScene.sprites).toHaveLength(0);
    expect(outputs.degrades).toMatchObject([
      { code: 'sprite-invalid-position', detail: 'bottom' },
    ]);
  });

  it('<stage/> 清空立绘', () => {
    const priorState: ParserState = {
      ...makeInitial(),
      lastScene: {
        background: 'cafe_interior',
        sprites: [{ id: 'sakuya', emotion: 'smile', position: 'center' }],
      },
    };
    const { state, outputs } = run(
      [
        { type: 'opentag', name: 'narration', attrs: {} },
        { type: 'opentag', name: 'stage', attrs: {} },
        { type: 'closetag', name: 'stage' },
        { type: 'text', data: 'empty' },
        { type: 'closetag', name: 'narration' },
      ],
      MANIFEST,
      priorState,
    );
    expect(state.lastScene.sprites).toEqual([]);
    expect(outputs.sentences[0]!.spritesChanged).toBe(true);
  });

  it('同 char 多次 <sprite/> → 取最后一个', () => {
    const { state } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      {
        type: 'opentag',
        name: 'sprite',
        attrs: { char: 'sakuya', mood: 'smile', position: 'left' },
      },
      { type: 'closetag', name: 'sprite' },
      {
        type: 'opentag',
        name: 'sprite',
        attrs: { char: 'sakuya', mood: 'worried', position: 'center' },
      },
      { type: 'closetag', name: 'sprite' },
      { type: 'text', data: 'x' },
      { type: 'closetag', name: 'narration' },
    ]);
    expect(state.lastScene.sprites).toEqual([
      { id: 'sakuya', emotion: 'worried', position: 'center' },
    ]);
  });

  it('同 position 不同 char → 后者覆盖前者', () => {
    const { state } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      {
        type: 'opentag',
        name: 'sprite',
        attrs: { char: 'sakuya', mood: 'smile', position: 'center' },
      },
      { type: 'closetag', name: 'sprite' },
      {
        type: 'opentag',
        name: 'sprite',
        attrs: { char: 'karina', mood: 'serious', position: 'center' },
      },
      { type: 'closetag', name: 'sprite' },
      { type: 'text', data: 'x' },
      { type: 'closetag', name: 'narration' },
    ]);
    expect(state.lastScene.sprites).toEqual([
      { id: 'karina', emotion: 'serious', position: 'center' },
    ]);
  });

  it('顶层出现 <sprite/> 时忽略，不崩', () => {
    const { outputs } = run([
      {
        type: 'opentag',
        name: 'sprite',
        attrs: { char: 'sakuya', mood: 'smile', position: 'left' },
      },
      { type: 'closetag', name: 'sprite' },
    ]);
    expect(outputs.sentences).toHaveLength(0);
    expect(outputs.degrades).toHaveLength(0);
  });
});

// ============================================================================
// <scratch> 出口
// ============================================================================

describe('reduce · <scratch>', () => {
  it('<scratch>text</scratch> → 产出 ScratchBlock', () => {
    const { outputs, state } = run([
      { type: 'opentag', name: 'scratch', attrs: {} },
      { type: 'text', data: '我先想一想：调用 read_state...' },
      { type: 'closetag', name: 'scratch' },
    ]);
    expect(outputs.scratches).toHaveLength(1);
    expect(outputs.scratches[0]!.text).toBe('我先想一想：调用 read_state...');
    expect(outputs.scratches[0]!.turnNumber).toBe(1);
    expect(outputs.scratches[0]!.index).toBe(0);
    expect(outputs.sentences).toHaveLength(0);
    expect(state.nextIndex).toBe(1);
  });

  it('空 <scratch></scratch> → 丢弃，不占 index', () => {
    const { outputs, state } = run([
      { type: 'opentag', name: 'scratch', attrs: {} },
      { type: 'text', data: '   \n ' },
      { type: 'closetag', name: 'scratch' },
    ]);
    expect(outputs.scratches).toHaveLength(0);
    expect(outputs.sentences).toHaveLength(0);
    expect(state.nextIndex).toBe(0);
  });

  it('<scratch> 内部的视觉 tag 被忽略', () => {
    const { state } = run([
      { type: 'opentag', name: 'scratch', attrs: {} },
      { type: 'opentag', name: 'background', attrs: { scene: 'plaza_day' } },
      { type: 'closetag', name: 'background' },
      { type: 'text', data: '思考' },
      { type: 'closetag', name: 'scratch' },
    ]);
    expect(state.lastScene.background).toBeNull();
  });

  it('<scratch> 和 <narration> 共用 index 计数器', () => {
    const { outputs, state } = run([
      { type: 'opentag', name: 'scratch', attrs: {} },
      { type: 'text', data: 'meta' },
      { type: 'closetag', name: 'scratch' },
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: 'visible' },
      { type: 'closetag', name: 'narration' },
    ]);
    expect(outputs.scratches[0]!.index).toBe(0);
    expect(outputs.sentences[0]!.index).toBe(1);
    expect(state.nextIndex).toBe(2);
  });
});

// ============================================================================
// finalize（流截断）
// ============================================================================

describe('reduce · finalize / truncation', () => {
  it('finalize 时无未闭合容器 → 标记 finalized，无 outputs', () => {
    const { state, outputs } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: 'closed normally' },
      { type: 'closetag', name: 'narration' },
      { type: 'finalize' },
    ]);
    expect(state.finalized).toBe(true);
    expect(outputs.sentences).toHaveLength(1);
    expect(outputs.degrades).toHaveLength(0);
  });

  it('<dialogue> 未闭合 + finalize → truncated:true + degrade', () => {
    const { outputs, state } = run([
      { type: 'opentag', name: 'dialogue', attrs: { speaker: 'sakuya' } },
      { type: 'text', data: '被截断' },
      { type: 'finalize' },
    ]);
    expect(outputs.sentences).toHaveLength(1);
    const s = outputs.sentences[0]!;
    expect(s.kind).toBe('dialogue');
    expect(s.truncated).toBe(true);
    expect(outputs.degrades).toMatchObject([
      { code: 'container-truncated', detail: 'dialogue' },
    ]);
    expect(state.finalized).toBe(true);
    expect(state.containerStack).toEqual([]);
  });

  it('多层嵌套未闭合 → 全部 flush，都 truncated', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: 'outer' },
      { type: 'opentag', name: 'dialogue', attrs: { speaker: 'karina' } },
      { type: 'text', data: 'inner' },
      { type: 'finalize' },
    ]);
    expect(outputs.sentences).toHaveLength(2);
    expect(outputs.sentences.every((s) => s.truncated === true)).toBe(true);
    expect(
      outputs.degrades.filter((d) => d.code === 'container-truncated'),
    ).toHaveLength(2);
  });

  it('finalized 后新事件都被忽略', () => {
    const { state: after } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'closetag', name: 'narration' },
      { type: 'finalize' },
    ]);
    // 尝试再喂入
    const { outputs } = run(
      [
        { type: 'opentag', name: 'narration', attrs: {} },
        { type: 'text', data: 'ignored' },
        { type: 'closetag', name: 'narration' },
      ],
      MANIFEST,
      after,
    );
    expect(outputs.sentences).toHaveLength(0);
  });

  it('未闭合 <scratch> + finalize → 产出 ScratchBlock 但不 degrade', () => {
    // scratch 截断的语义 = 仍然产出（内容已经 assistant 说过了），
    // 不像 dialogue/narration 要标 truncated 因为它们要渲染。
    const { outputs } = run([
      { type: 'opentag', name: 'scratch', attrs: {} },
      { type: 'text', data: '未完成的思考' },
      { type: 'finalize' },
    ]);
    expect(outputs.scratches).toHaveLength(1);
    expect(outputs.scratches[0]!.text).toBe('未完成的思考');
  });
});

// ============================================================================
// Scene 继承（跨 sentence）
// ============================================================================

describe('reduce · scene 跨 sentence 继承', () => {
  it('第二句继承第一句的 bg', () => {
    const { outputs, state } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'opentag', name: 'background', attrs: { scene: 'plaza_day' } },
      { type: 'closetag', name: 'background' },
      { type: 'text', data: 's1' },
      { type: 'closetag', name: 'narration' },
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: 's2' },
      { type: 'closetag', name: 'narration' },
    ]);
    expect(outputs.sentences).toHaveLength(2);
    const [first, second] = outputs.sentences;
    expect(first!.sceneRef.background).toBe('plaza_day');
    expect(first!.bgChanged).toBe(true);
    expect(second!.sceneRef.background).toBe('plaza_day');
    expect(second!.bgChanged).toBe(false);
    expect(state.lastScene.background).toBe('plaza_day');
  });

  it('index 在 dialogue + narration 之间递增', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'dialogue', attrs: { speaker: 'sakuya' } },
      { type: 'text', data: 'a' },
      { type: 'closetag', name: 'dialogue' },
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: 'b' },
      { type: 'closetag', name: 'narration' },
      { type: 'opentag', name: 'dialogue', attrs: { speaker: 'karina' } },
      { type: 'text', data: 'c' },
      { type: 'closetag', name: 'dialogue' },
    ]);
    expect(outputs.sentences.map((s) => s.index)).toEqual([0, 1, 2]);
  });
});

// ============================================================================
// 嵌套 / mismatch 容错
// ============================================================================

describe('reduce · mismatch / 容错', () => {
  it('错位 close tag 名 → 按栈顶 kind emit', () => {
    // <narration>hi</dialogue>  — 标签名不匹配，但仍按 narration 产出
    const { outputs } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: 'hi' },
      { type: 'closetag', name: 'dialogue' }, // 错位
    ]);
    expect(outputs.sentences).toHaveLength(1);
    expect(outputs.sentences[0]!.kind).toBe('narration');
  });

  it('close 一个从未 open 的 tag → 忽略', () => {
    const { outputs, state } = run([
      { type: 'closetag', name: 'dialogue' },
    ]);
    expect(outputs.sentences).toHaveLength(0);
    expect(state.containerStack).toEqual([]);
  });
});
