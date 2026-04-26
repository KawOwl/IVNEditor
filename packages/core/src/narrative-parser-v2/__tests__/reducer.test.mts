/**
 * reducer.ts — 纯函数单测
 *
 * 直接用合成的 ParserEvent 序列驱动 reduce()，不经过 htmlparser2。
 * 覆盖 RFC §4.3 每条 silent tolerance 降级 + `<scratch>` 出口。
 */

import { describe, it, expect } from 'bun:test';
import type { SceneState } from '#internal/types';
import { reduce, type ParserEvent } from '#internal/narrative-parser-v2/reducer';
import {
  initialParserState,
  type ParserManifest,
  type ParserState,
  type ReducerOutputs,
} from '#internal/narrative-parser-v2/state';

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
  defaultMoodByChar: new Map([
    ['sakuya', 'neutral'],
    ['karina', 'serious'],
    ['mc', 'neutral'],
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
    // speaker 漏 sprite + 不在 prev 台上 → 兜底补 sakuya 默认 sprite，emit
    // dialogue-speaker-sprite-fallback 中性事件（不算降级，仅供 trace 量化）
    expect(outputs.degrades).toMatchObject([
      { code: 'dialogue-speaker-sprite-fallback', detail: 'sakuya:neutral@center' },
    ]);
    expect(s.sceneRef.sprites).toEqual([
      { id: 'sakuya', emotion: 'neutral', position: 'center' },
    ]);
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

  it('<dialogue> speaker 不在白名单且无 __npc__ 前缀 → 保留 dialogue + unknown degrade', () => {
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

  it('<dialogue speaker="__npc__保安"> → dialogue + adhoc 事件，不发 unknown degrade', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'dialogue', attrs: { speaker: '__npc__保安' } },
      { type: 'text', data: '你不能在这里拍照。' },
      { type: 'closetag', name: 'dialogue' },
    ]);
    expect(outputs.sentences).toHaveLength(1);
    const s = outputs.sentences[0]!;
    expect(s.kind).toBe('dialogue');
    if (s.kind === 'dialogue') {
      // pf.speaker 保留完整 raw 字符串，UI 渲染时 strip 前缀
      expect(s.pf.speaker).toBe('__npc__保安');
      expect(s.text).toBe('你不能在这里拍照。');
    }
    expect(outputs.degrades).toMatchObject([
      { code: 'dialogue-adhoc-speaker', detail: '__npc__保安' },
    ]);
    expect(outputs.degrades.some((d) => d.code === 'dialogue-unknown-speaker')).toBe(false);
  });

  it('<dialogue speaker="__npc__店主" to="__npc__同事,player"> → pf.addressee 透传 ad-hoc id', () => {
    const { outputs } = run([
      {
        type: 'opentag',
        name: 'dialogue',
        attrs: { speaker: '__npc__店主', to: '__npc__同事, player' },
      },
      { type: 'text', data: '欢迎光临' },
      { type: 'closetag', name: 'dialogue' },
    ]);
    expect(outputs.sentences).toHaveLength(1);
    const s = outputs.sentences[0]!;
    if (s.kind !== 'dialogue') throw new Error('expected dialogue');
    expect(s.pf.speaker).toBe('__npc__店主');
    expect(s.pf.addressee).toEqual(['__npc__同事', 'player']);
    expect(outputs.degrades.some((d) => d.code === 'dialogue-adhoc-speaker' && d.detail === '__npc__店主')).toBe(true);
    expect(outputs.degrades.some((d) => d.code === 'dialogue-unknown-speaker')).toBe(false);
  });

  it.each([
    '__npc__你',
    '__npc__我',
    '__npc__他',
    '__npc__她',
    '__npc__它',
    '__npc__他们',
    '__npc__她们',
    '__npc__咱',
    '__npc__自己',
    '__npc__主角',
  ])('<dialogue speaker="%s"> → emit dialogue-pronoun-as-speaker（不是 adhoc-speaker）', (speakerId) => {
    const { outputs } = run([
      { type: 'opentag', name: 'dialogue', attrs: { speaker: speakerId } },
      { type: 'text', data: '...' },
      { type: 'closetag', name: 'dialogue' },
    ]);
    expect(outputs.sentences).toHaveLength(1);
    expect(outputs.sentences[0]!.kind).toBe('dialogue');
    expect(outputs.degrades).toMatchObject([
      { code: 'dialogue-pronoun-as-speaker', detail: speakerId },
    ]);
    // 互斥：pronoun 路径不再 emit 中性 adhoc-speaker，避免 trace 双计数
    expect(outputs.degrades.some((d) => d.code === 'dialogue-adhoc-speaker')).toBe(false);
  });

  it('<dialogue speaker="__npc__你的"> → 后缀含代词但不等于代词，仍走 adhoc 路径', () => {
    // 前缀匹配不算代词，必须显示名整体相等。"你的"是合法 ad-hoc 显示名。
    const { outputs } = run([
      { type: 'opentag', name: 'dialogue', attrs: { speaker: '__npc__你的' } },
      { type: 'text', data: '...' },
      { type: 'closetag', name: 'dialogue' },
    ]);
    expect(outputs.degrades).toMatchObject([
      { code: 'dialogue-adhoc-speaker', detail: '__npc__你的' },
    ]);
    expect(outputs.degrades.some((d) => d.code === 'dialogue-pronoun-as-speaker')).toBe(false);
  });

  it('<dialogue speaker="__npc__"> 裸前缀 → 走 adhoc 路径不当代词处理', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'dialogue', attrs: { speaker: '__npc__' } },
      { type: 'text', data: '...' },
      { type: 'closetag', name: 'dialogue' },
    ]);
    expect(outputs.degrades.some((d) => d.code === 'dialogue-pronoun-as-speaker')).toBe(false);
    expect(outputs.degrades.some((d) => d.code === 'dialogue-adhoc-speaker')).toBe(true);
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

  it('LLM 漏 sprite 真实 trace 复现：<dialogue speaker="karina" mood="curious"> 自动补 karina 默认立绘', () => {
    // trace 784ab8fc 现场：LLM 把 mood 写到 dialogue 上（被 silent 忽略），
    // 没有 <sprite> 子标签且 prev 不在台上，玩家屏幕看不到 karina 立绘。
    // V.9 兜底：speaker 在白名单 + 不在台上 → 自动补 manifest 默认 sprite。
    const { outputs } = run([
      {
        type: 'opentag',
        name: 'dialogue',
        attrs: { speaker: 'karina', to: 'player', mood: 'curious' },
      },
      { type: 'text', data: '"不过你刚才也看到了..."' },
      { type: 'closetag', name: 'dialogue' },
    ]);
    expect(outputs.sentences).toHaveLength(1);
    const s = outputs.sentences[0]!;
    if (s.kind !== 'dialogue') throw new Error('expected dialogue');
    expect(s.sceneRef.sprites).toEqual([
      { id: 'karina', emotion: 'serious', position: 'center' },
    ]);
    expect(s.spritesChanged).toBe(true);
    expect(outputs.degrades).toMatchObject([
      { code: 'dialogue-speaker-sprite-fallback', detail: 'karina:serious@center' },
    ]);
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
// 段落切分（\n\n 分段 → 1 容器产多条 Sentence，共享 sceneRef/pf）
// ============================================================================

describe('reduce · 段落切分（\\n\\n）', () => {
  it('<narration> 两段 \\n\\n → 2 条 narration Sentence，index 连续', () => {
    const { state, outputs } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: '第一段文字。\n\n第二段文字。' },
      { type: 'closetag', name: 'narration' },
    ]);
    expect(outputs.sentences).toHaveLength(2);
    expect(outputs.sentences[0]!.kind).toBe('narration');
    expect(outputs.sentences[1]!.kind).toBe('narration');
    expect(outputs.sentences[0]!.text).toBe('第一段文字。');
    expect(outputs.sentences[1]!.text).toBe('第二段文字。');
    expect(outputs.sentences[0]!.index).toBe(0);
    expect(outputs.sentences[1]!.index).toBe(1);
    expect(state.nextIndex).toBe(2);
  });

  it('多段切分共享同一 sceneRef（容器 = 视觉单元）', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'opentag', name: 'background', attrs: { scene: 'plaza_day' } },
      { type: 'closetag', name: 'background' },
      { type: 'text', data: '段一。\n\n段二。\n\n段三。' },
      { type: 'closetag', name: 'narration' },
    ]);
    expect(outputs.sentences).toHaveLength(3);
    const scenes = outputs.sentences.map((s) => s.sceneRef.background);
    expect(scenes).toEqual(['plaza_day', 'plaza_day', 'plaza_day']);
  });

  it('bgChanged / spritesChanged 只打在第一条', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'opentag', name: 'background', attrs: { scene: 'plaza_day' } },
      { type: 'closetag', name: 'background' },
      {
        type: 'opentag',
        name: 'sprite',
        attrs: { char: 'sakuya', mood: 'smile', position: 'center' },
      },
      { type: 'closetag', name: 'sprite' },
      { type: 'text', data: '第一段。\n\n第二段。' },
      { type: 'closetag', name: 'narration' },
    ]);
    expect(outputs.sentences).toHaveLength(2);
    expect(outputs.sentences[0]!.bgChanged).toBe(true);
    expect(outputs.sentences[0]!.spritesChanged).toBe(true);
    expect(outputs.sentences[1]!.bgChanged).toBe(false);
    expect(outputs.sentences[1]!.spritesChanged).toBe(false);
  });

  it('truncated 只打在最后一条（container-truncated degrade 仍然只一条）', () => {
    // 未闭合 → finalize 强制 close
    const { outputs } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: '段一。\n\n段二。\n\n段三（截断）' },
      { type: 'finalize' },
    ]);
    expect(outputs.sentences).toHaveLength(3);
    expect(outputs.sentences[0]!.truncated).toBeUndefined();
    expect(outputs.sentences[1]!.truncated).toBeUndefined();
    expect(outputs.sentences[2]!.truncated).toBe(true);
    const trunc = outputs.degrades.filter((d) => d.code === 'container-truncated');
    expect(trunc).toHaveLength(1);
  });

  it('<dialogue> 多段 \\n\\n → 多条 dialogue Sentence，共享同一 PF', () => {
    const { outputs } = run([
      {
        type: 'opentag',
        name: 'dialogue',
        attrs: { speaker: 'sakuya', to: 'karina' },
      },
      { type: 'text', data: '第一句话。\n\n第二句话。' },
      { type: 'closetag', name: 'dialogue' },
    ]);
    expect(outputs.sentences).toHaveLength(2);
    for (const s of outputs.sentences) {
      expect(s.kind).toBe('dialogue');
      if (s.kind === 'dialogue') {
        expect(s.pf.speaker).toBe('sakuya');
        expect(s.pf.addressee).toEqual(['karina']);
      }
    }
  });

  it('dialogue 多段：truncated 只贴最后一条', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'dialogue', attrs: { speaker: 'sakuya' } },
      { type: 'text', data: '一句。\n\n两句（截断）' },
      { type: 'finalize' },
    ]);
    expect(outputs.sentences).toHaveLength(2);
    expect(outputs.sentences[0]!.truncated).toBeUndefined();
    expect(outputs.sentences[1]!.truncated).toBe(true);
  });

  it('dialogue 缺 speaker + 多段 → 全部降级 narration + 一条 degrade', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'dialogue', attrs: {} },
      { type: 'text', data: '匿名段一。\n\n匿名段二。' },
      { type: 'closetag', name: 'dialogue' },
    ]);
    expect(outputs.sentences).toHaveLength(2);
    expect(outputs.sentences[0]!.kind).toBe('narration');
    expect(outputs.sentences[1]!.kind).toBe('narration');
    const miss = outputs.degrades.filter((d) => d.code === 'dialogue-missing-speaker');
    expect(miss).toHaveLength(1);
  });

  it('dialogue unknown speaker + 多段 → 保留 dialogue + degrade 只一条', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'dialogue', attrs: { speaker: 'ghost' } },
      { type: 'text', data: 'boo 1。\n\nboo 2。' },
      { type: 'closetag', name: 'dialogue' },
    ]);
    expect(outputs.sentences).toHaveLength(2);
    expect(outputs.sentences[0]!.kind).toBe('dialogue');
    expect(outputs.sentences[1]!.kind).toBe('dialogue');
    const unknown = outputs.degrades.filter((d) => d.code === 'dialogue-unknown-speaker');
    expect(unknown).toHaveLength(1);
  });

  it('空行后跟空行（\\n\\n\\n）仍只切一次，空段被丢弃', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: '段一\n\n\n\n段二' },
      { type: 'closetag', name: 'narration' },
    ]);
    expect(outputs.sentences).toHaveLength(2);
    expect(outputs.sentences[0]!.text).toBe('段一');
    expect(outputs.sentences[1]!.text).toBe('段二');
  });

  it('空行里夹空白（\\n \\t \\n）也识别为段落边界', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: '段一\n \t \n段二' },
      { type: 'closetag', name: 'narration' },
    ]);
    expect(outputs.sentences).toHaveLength(2);
    expect(outputs.sentences[0]!.text).toBe('段一');
    expect(outputs.sentences[1]!.text).toBe('段二');
  });

  it('空 <narration></narration> → 0 条 Sentence（无空段污染）', () => {
    const { state, outputs } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'closetag', name: 'narration' },
    ]);
    expect(outputs.sentences).toHaveLength(0);
    expect(outputs.degrades).toHaveLength(0);
    expect(state.nextIndex).toBe(0);
  });

  it('单段（无 \\n\\n）仍是 1 条 Sentence（向后兼容）', () => {
    const { state, outputs } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: '只有一段，没有空行。包含单个 \\n 也不切。\n就还是这一段。' },
      { type: 'closetag', name: 'narration' },
    ]);
    expect(outputs.sentences).toHaveLength(1);
    expect(state.nextIndex).toBe(1);
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
    // sceneDegrades 先 emit（含 fallback），然后是 truncDegrade
    expect(outputs.degrades).toMatchObject([
      { code: 'dialogue-speaker-sprite-fallback' },
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

// ============================================================================
// typo close tag + drain-on-open（carina trace d6ef2af7 回归）
// ============================================================================

describe('reduce · typo close tag → unknown-close-tag degrade + drain on next open', () => {
  it('未知 close tag 自身不闭合容器，但 emit unknown-close-tag degrade', () => {
    const { outputs, state } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: 'hi' },
      { type: 'closetag', name: 'narrtion' }, // typo
    ]);
    // 未关，narration 留在栈上
    expect(state.containerStack).toHaveLength(1);
    expect(state.containerStack[0]!.kind).toBe('narration');
    // sentence 不产，但 degrade 留痕
    expect(outputs.sentences).toHaveLength(0);
    expect(outputs.degrades).toMatchObject([{ code: 'unknown-close-tag', detail: 'narrtion' }]);
  });

  it('typo close 后开新顶层 → drain 旧容器为 truncated，emit 顺序对齐文本顺序', () => {
    const { outputs } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: 'first' },
      { type: 'closetag', name: 'narrtion' }, // typo
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: 'second' },
      { type: 'closetag', name: 'narration' },
    ]);
    expect(outputs.sentences).toHaveLength(2);
    expect(outputs.sentences[0]!.kind).toBe('narration');
    expect(outputs.sentences[0]!.text).toBe('first');
    expect(outputs.sentences[0]!.truncated).toBe(true);
    expect(outputs.sentences[0]!.index).toBe(0);
    expect(outputs.sentences[1]!.kind).toBe('narration');
    expect(outputs.sentences[1]!.text).toBe('second');
    expect(outputs.sentences[1]!.truncated).toBeUndefined();
    expect(outputs.sentences[1]!.index).toBe(1);
  });

  it('carina trace 完整复现：narr-typo, narr-typo, dialogue → 三条按文本顺序', () => {
    // d6ef2af7 现场：两段 narration 用 </narrtion> 错字关，紧跟 carina 对白。
    // 修复前：carina index=0, 两条 narration index=1/2 truncated 甩到末尾。
    // 修复后：narr1 → narr2 → carina，index 0/1/2 严格对齐文本顺序。
    const { outputs } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: '你放下相机。' },
      { type: 'closetag', name: 'narrtion' },
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: '巷子安静了一瞬。' },
      { type: 'closetag', name: 'narrtion' },
      { type: 'opentag', name: 'dialogue', attrs: { speaker: 'karina' } },
      { type: 'text', data: '"他在拍照。"' },
      { type: 'closetag', name: 'dialogue' },
    ]);

    expect(outputs.sentences).toHaveLength(3);
    expect(outputs.sentences[0]!.kind).toBe('narration');
    expect(outputs.sentences[0]!.text).toBe('你放下相机。');
    expect(outputs.sentences[0]!.truncated).toBe(true);
    expect(outputs.sentences[0]!.index).toBe(0);

    expect(outputs.sentences[1]!.kind).toBe('narration');
    expect(outputs.sentences[1]!.text).toBe('巷子安静了一瞬。');
    expect(outputs.sentences[1]!.truncated).toBe(true);
    expect(outputs.sentences[1]!.index).toBe(1);

    expect(outputs.sentences[2]!.kind).toBe('dialogue');
    expect(outputs.sentences[2]!.text).toBe('"他在拍照。"');
    expect(outputs.sentences[2]!.truncated).toBeUndefined();
    expect(outputs.sentences[2]!.index).toBe(2);

    // 两条 typo close 各自一条 degrade
    const unknownClose = outputs.degrades.filter((d) => d.code === 'unknown-close-tag');
    expect(unknownClose).toHaveLength(2);
    expect(unknownClose.every((d) => d.detail === 'narrtion')).toBe(true);

    // 两条被强制关掉的 narration 各自一条 container-truncated
    const truncated = outputs.degrades.filter((d) => d.code === 'container-truncated');
    expect(truncated).toHaveLength(2);
  });

  it('同 kind 嵌套（无 typo）→ 外层 auto-close truncated', () => {
    // <narration>outer<narration>inner</narration> ← outer 没关
    const { outputs } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: 'outer' },
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: 'inner' },
      { type: 'closetag', name: 'narration' },
    ]);
    expect(outputs.sentences).toHaveLength(2);
    expect(outputs.sentences[0]!.text).toBe('outer');
    expect(outputs.sentences[0]!.truncated).toBe(true);
    expect(outputs.sentences[0]!.index).toBe(0);
    expect(outputs.sentences[1]!.text).toBe('inner');
    expect(outputs.sentences[1]!.truncated).toBeUndefined();
    expect(outputs.sentences[1]!.index).toBe(1);
  });

  it('异 kind 嵌套（无 typo）→ 外层也 auto-close（顶层平铺规则）', () => {
    // <narration>outer<dialogue speaker="x">inner</dialogue> ← outer 没关
    // 修复前：finalize-time LIFO drain → dialogue index 0, narration index 1 truncated
    // 修复后：dialogue open 先 drain narration → narration index 0 truncated, dialogue index 1
    const { outputs } = run([
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: 'outer' },
      { type: 'opentag', name: 'dialogue', attrs: { speaker: 'sakuya' } },
      { type: 'text', data: 'inner' },
      { type: 'closetag', name: 'dialogue' },
    ]);
    expect(outputs.sentences).toHaveLength(2);
    expect(outputs.sentences[0]!.kind).toBe('narration');
    expect(outputs.sentences[0]!.text).toBe('outer');
    expect(outputs.sentences[0]!.truncated).toBe(true);
    expect(outputs.sentences[0]!.index).toBe(0);
    expect(outputs.sentences[1]!.kind).toBe('dialogue');
    expect(outputs.sentences[1]!.text).toBe('inner');
    expect(outputs.sentences[1]!.truncated).toBeUndefined();
    expect(outputs.sentences[1]!.index).toBe(1);
  });

  it('typo close 在 dialogue 容器里 → 同样 emit unknown-close-tag', () => {
    // 不只是 narration 错字 —— dialogue 错字也要留痕
    const { outputs } = run([
      { type: 'opentag', name: 'dialogue', attrs: { speaker: 'sakuya' } },
      { type: 'text', data: 'hi' },
      { type: 'closetag', name: 'dialouge' }, // typo
      { type: 'opentag', name: 'narration', attrs: {} },
      { type: 'text', data: 'next' },
      { type: 'closetag', name: 'narration' },
    ]);
    expect(outputs.sentences).toHaveLength(2);
    expect(outputs.sentences[0]!.kind).toBe('dialogue');
    expect(outputs.sentences[0]!.truncated).toBe(true);
    expect(outputs.sentences[1]!.kind).toBe('narration');
    expect(outputs.degrades.some((d) => d.code === 'unknown-close-tag' && d.detail === 'dialouge')).toBe(true);
  });
});
