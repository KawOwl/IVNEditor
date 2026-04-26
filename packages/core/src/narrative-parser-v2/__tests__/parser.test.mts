/**
 * parser.ts — 组合层集成单测
 *
 * 通过 createParser({...}).feed(chunk).finalize() 走真实 htmlparser2 胶水层。
 * 覆盖：chunk 边界重组、自闭合 tag、<scratch> 流、truncated、index 连续性。
 */

import { describe, it, expect } from 'bun:test';
import type { SceneState } from '#internal/types';
import {
  createParser,
  buildParserManifest,
  type ParserManifest,
} from '#internal/narrative-parser-v2';

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

function makeParser(startIndex = 0, turnNumber = 1) {
  return createParser({
    manifest: MANIFEST,
    turnNumber,
    startIndex,
    initialScene: INITIAL_SCENE,
  });
}

/** 把源文本按固定长度切成 chunks，喂给 parser，累积产物。 */
function feedInChunks(
  parser: ReturnType<typeof createParser>,
  src: string,
  chunkSize: number,
) {
  let sentences: ReturnType<typeof parser.feed>['sentences'] = [];
  let scratches: ReturnType<typeof parser.feed>['scratches'] = [];
  let degrades: ReturnType<typeof parser.feed>['degrades'] = [];
  for (let i = 0; i < src.length; i += chunkSize) {
    const batch = parser.feed(src.slice(i, i + chunkSize));
    sentences = [...sentences, ...batch.sentences];
    scratches = [...scratches, ...batch.scratches];
    degrades = [...degrades, ...batch.degrades];
  }
  const tail = parser.finalize();
  return {
    sentences: [...sentences, ...tail.sentences],
    scratches: [...scratches, ...tail.scratches],
    degrades: [...degrades, ...tail.degrades],
  };
}

// ============================================================================
// 基础流
// ============================================================================

describe('createParser · 基础', () => {
  it('完整 dialogue + narration round-trip', () => {
    const p = makeParser();
    const batch = p.feed(
      `<narration><background scene="cafe_interior"/>午后的咖啡店。</narration>` +
        `<dialogue speaker="sakuya">你来了。</dialogue>`,
    );
    const finalBatch = p.finalize();
    const sentences = [...batch.sentences, ...finalBatch.sentences];
    expect(sentences).toHaveLength(2);
    expect(sentences[0]!.kind).toBe('narration');
    expect(sentences[0]!.sceneRef.background).toBe('cafe_interior');
    expect(sentences[1]!.kind).toBe('dialogue');
    if (sentences[1]!.kind === 'dialogue') {
      expect(sentences[1]!.pf.speaker).toBe('sakuya');
      expect(sentences[1]!.text).toBe('你来了。');
    }
  });

  it('自闭合 <background/> 被识别（<sprite/> <stage/> 简化版静默忽略）', () => {
    const p = makeParser();
    const { sentences } = feedInChunks(
      p,
      `<narration>` +
        `<background scene="plaza_day"/>` +
        `<sprite char="sakuya" mood="smile" position="center"/>` +
        `<stage/>` +
        `street view` +
        `</narration>`,
      1000,
    );
    expect(sentences).toHaveLength(1);
    expect(sentences[0]!.sceneRef.background).toBe('plaza_day');
    // 简化版：narration 立绘恒为空，<sprite/>/<stage/> 被解析但不影响输出
    expect(sentences[0]!.sceneRef.sprites).toEqual([]);
  });
});

// ============================================================================
// Chunk 切分重组
// ============================================================================

describe('createParser · chunk 边界', () => {
  const SRC =
    `<narration><background scene="cafe_interior"/>A段叙述内容。</narration>` +
    `<dialogue speaker="sakuya" to="karina">` +
    `<sprite char="sakuya" mood="smile" position="center"/>` +
    `你好啊。</dialogue>`;

  it.each([1, 2, 3, 5, 7, 13, 50, 1000])(
    'chunk size = %i → 产物稳定',
    (size) => {
      const { sentences, degrades } = feedInChunks(makeParser(), SRC, size);
      expect(sentences).toHaveLength(2);
      expect(sentences[0]!.kind).toBe('narration');
      expect(sentences[0]!.text).toBe('A段叙述内容。');
      expect(sentences[0]!.sceneRef.background).toBe('cafe_interior');
      expect(sentences[1]!.kind).toBe('dialogue');
      expect(sentences[1]!.text).toBe('你好啊。');
      if (sentences[1]!.kind === 'dialogue') {
        expect(sentences[1]!.pf.speaker).toBe('sakuya');
        expect(sentences[1]!.pf.addressee).toEqual(['karina']);
      }
      expect(degrades).toHaveLength(0);
    },
  );

  it('chunk 切在属性引号中间', () => {
    const p = makeParser();
    // `scene="plaz` | `a_day"` — 切在属性值中
    const a = p.feed('<narration><background scene="plaz');
    const b = p.feed('a_day"/>seeing the plaza</narration>');
    const c = p.finalize();
    const sentences = [...a.sentences, ...b.sentences, ...c.sentences];
    expect(sentences).toHaveLength(1);
    expect(sentences[0]!.sceneRef.background).toBe('plaza_day');
  });

  it('chunk 切在 tag open 的 <', () => {
    const p = makeParser();
    const a = p.feed('<narration>hi <');
    const b = p.feed('/narration>');
    const c = p.finalize();
    const sentences = [...a.sentences, ...b.sentences, ...c.sentences];
    expect(sentences).toHaveLength(1);
    expect(sentences[0]!.text).toBe('hi');
  });

  it('chunk 切在 <dialogue speaker= 中', () => {
    const p = makeParser();
    const a = p.feed('<dialogue speaker=');
    const b = p.feed('"sakuya">hello</dialogue>');
    const c = p.finalize();
    const sentences = [...a.sentences, ...b.sentences, ...c.sentences];
    expect(sentences).toHaveLength(1);
    expect(sentences[0]!.kind).toBe('dialogue');
    if (sentences[0]!.kind === 'dialogue') {
      expect(sentences[0]!.pf.speaker).toBe('sakuya');
    }
  });
});

// ============================================================================
// truncation / finalize
// ============================================================================

describe('createParser · stream truncation', () => {
  it('未闭合 dialogue + finalize → truncated:true', () => {
    const p = makeParser();
    p.feed('<dialogue speaker="sakuya">我还没说完');
    const { sentences, degrades } = p.finalize();
    expect(sentences).toHaveLength(1);
    expect(sentences[0]!.truncated).toBe(true);
    expect(degrades).toMatchObject([
      { code: 'container-truncated', detail: 'dialogue' },
    ]);
  });

  it('finalize 后 feed 被忽略', () => {
    const p = makeParser();
    p.feed('<narration>a</narration>');
    p.finalize();
    const after = p.feed('<narration>b</narration>');
    expect(after.sentences).toHaveLength(0);
  });

  it('重复 finalize 幂等', () => {
    const p = makeParser();
    // 完整闭合的 narration 在 feed() 就被 drain 了，finalize tail 为空。
    const mid = p.feed('<narration>a</narration>');
    const first = p.finalize();
    const second = p.finalize();
    expect(mid.sentences).toHaveLength(1);
    expect(first.sentences).toHaveLength(0);
    expect(second.sentences).toHaveLength(0);
  });
});

// ============================================================================
// <scratch> 出口
// ============================================================================

describe('createParser · <scratch>', () => {
  it('scratch 产出 ScratchBlock 而非 Sentence', () => {
    const p = makeParser();
    const { sentences, scratches } = feedInChunks(
      p,
      `<scratch>先想想状态...</scratch>` +
        `<narration>日光正好。</narration>`,
      1000,
    );
    expect(scratches).toHaveLength(1);
    expect(scratches[0]!.text).toBe('先想想状态...');
    expect(sentences).toHaveLength(1);
    expect(sentences[0]!.kind).toBe('narration');
  });

  it('scratch + narration index 连续', () => {
    const p = makeParser(10);
    const { sentences, scratches } = feedInChunks(
      p,
      `<scratch>a</scratch><narration>b</narration><scratch>c</scratch>`,
      1,
    );
    expect(scratches.map((s) => s.index)).toEqual([10, 12]);
    expect(sentences.map((s) => s.index)).toEqual([11]);
  });

  it('空 scratch 不产出', () => {
    const p = makeParser();
    const { scratches } = feedInChunks(
      p,
      `<scratch>   \n  </scratch>`,
      1000,
    );
    expect(scratches).toHaveLength(0);
  });

  it('跨 chunk 拼接的 scratch 文本完整保留', () => {
    const p = makeParser();
    // scratch 闭合的那个 feed 批次才会产出 block；收齐所有批次。
    const b1 = p.feed('<scratch>first');
    const b2 = p.feed(' chunk + second ');
    const b3 = p.feed('chunk</scratch>');
    const tail = p.finalize();
    const scratches = [
      ...b1.scratches,
      ...b2.scratches,
      ...b3.scratches,
      ...tail.scratches,
    ];
    expect(scratches).toHaveLength(1);
    expect(scratches[0]!.text).toBe('first chunk + second chunk');
  });
});

// ============================================================================
// Silent tolerance end-to-end
// ============================================================================

describe('createParser · silent tolerance e2e', () => {
  it('未知顶层 tag 被吞 + degrade + 后续正常', () => {
    const p = makeParser();
    const { sentences, degrades } = feedInChunks(
      p,
      `<foobar>should be swallowed</foobar>` +
        `<narration>survived</narration>`,
      3,
    );
    expect(sentences).toHaveLength(1);
    expect(sentences[0]!.text).toBe('survived');
    expect(degrades).toMatchObject([
      { code: 'unknown-toplevel-tag', detail: 'foobar' },
    ]);
  });

  it('多重非法 sprite + bg：bg 仍报错，sprite 层级简化版静默忽略', () => {
    const p = makeParser();
    const { sentences, degrades } = feedInChunks(
      p,
      `<narration>` +
        `<background scene="unknown_place"/>` +
        `<sprite char="ghost" mood="smile" position="center"/>` +
        `<sprite char="sakuya" mood="rage" position="left"/>` +
        `<sprite char="sakuya" mood="smile" position="floating"/>` +
        `ok` +
        `</narration>`,
      1000,
    );
    expect(sentences).toHaveLength(1);
    expect(sentences[0]!.sceneRef.background).toBeNull();
    expect(sentences[0]!.sceneRef.sprites).toEqual([]);
    // 简化版立绘规则：narration 一律不显示立绘，`<sprite>` 标签整体被忽略，
    // 所以 sprite 系列 degrade（unknown-char / unknown-mood / invalid-position）
    // 不再产生。仅 bg 校验依旧 emit。
    const codes = degrades.map((d) => d.code).sort();
    expect(codes).toEqual(
      [
        'bg-unknown-scene',
        'sprite-invalid-position',
      ].sort(),
    );
  });

  it('tag 大小写 → htmlparser2 lowercaseTags 统一识别', () => {
    const p = makeParser();
    const { sentences } = feedInChunks(
      p,
      `<NARRATION><BACKGROUND scene="plaza_day"/>hi</NARRATION>`,
      5,
    );
    expect(sentences).toHaveLength(1);
    expect(sentences[0]!.sceneRef.background).toBe('plaza_day');
  });
});

// ============================================================================
// snapshot / 起始状态
// ============================================================================

describe('createParser · snapshot + 起始', () => {
  it('snapshot() 返回当前 state', () => {
    const p = makeParser();
    expect(p.snapshot().finalized).toBe(false);
    p.feed('<narration>a</narration>');
    p.finalize();
    expect(p.snapshot().finalized).toBe(true);
  });

  it('起始 startIndex 正确应用', () => {
    const p = createParser({
      manifest: MANIFEST,
      turnNumber: 3,
      startIndex: 100,
      initialScene: INITIAL_SCENE,
    });
    const { sentences } = feedInChunks(
      p,
      `<narration>x</narration><narration>y</narration>`,
      1000,
    );
    expect(sentences.map((s) => s.index)).toEqual([100, 101]);
    expect(sentences.every((s) => s.turnNumber === 3)).toBe(true);
  });

  it('起始 initialScene 的 background 被第一句继承（sprites 简化版不继承）', () => {
    const p = createParser({
      manifest: MANIFEST,
      turnNumber: 1,
      startIndex: 0,
      initialScene: {
        background: 'cafe_interior',
        sprites: [{ id: 'sakuya', emotion: 'smile', position: 'center' }],
      },
    });
    const { sentences } = feedInChunks(
      p,
      `<narration>no-change</narration>`,
      1000,
    );
    expect(sentences[0]!.sceneRef.background).toBe('cafe_interior');
    expect(sentences[0]!.bgChanged).toBe(false);
    // 简化版：narration 始终 sprites=[]，不继承 initialScene 的立绘
    expect(sentences[0]!.sceneRef.sprites).toEqual([]);
    expect(sentences[0]!.spritesChanged).toBe(true);
  });
});

// ============================================================================
// buildParserManifest helper
// ============================================================================

describe('buildParserManifest', () => {
  it('从 ScriptManifestLike 构造出正确的白名单', () => {
    const manifest = buildParserManifest({
      characters: [
        {
          id: 'sakuya',
          sprites: [{ id: 'smile' }, { id: 'worried' }],
        },
        {
          id: 'karina',
          sprites: [{ id: 'serious' }],
        },
      ],
      backgrounds: [{ id: 'cafe' }, { id: 'park' }],
    });
    expect(manifest.characters.has('sakuya')).toBe(true);
    expect(manifest.characters.has('karina')).toBe(true);
    expect(manifest.characters.has('unknown')).toBe(false);
    expect(manifest.moodsByChar.get('sakuya')?.has('smile')).toBe(true);
    expect(manifest.moodsByChar.get('sakuya')?.has('rage')).toBe(false);
    expect(manifest.moodsByChar.get('karina')?.has('serious')).toBe(true);
    expect(manifest.backgrounds.has('cafe')).toBe(true);
    expect(manifest.backgrounds.has('park')).toBe(true);
    expect(manifest.backgrounds.has('mars')).toBe(false);
    // defaultMoodByChar 取每个角色 sprites 数组里的第一个
    expect(manifest.defaultMoodByChar.get('sakuya')).toBe('smile');
    expect(manifest.defaultMoodByChar.get('karina')).toBe('serious');
  });

  it('空输入 → 空 manifest', () => {
    const manifest = buildParserManifest({});
    expect(manifest.characters.size).toBe(0);
    expect(manifest.backgrounds.size).toBe(0);
    expect(manifest.defaultMoodByChar.size).toBe(0);
  });

  it('character 没有 sprites → defaultMoodByChar 不含该 key', () => {
    const manifest = buildParserManifest({
      characters: [{ id: 'voice_only', sprites: [] }],
    });
    expect(manifest.characters.has('voice_only')).toBe(true);
    expect(manifest.defaultMoodByChar.has('voice_only')).toBe(false);
  });
});

// ============================================================================
// 综合场景
// ============================================================================

describe('createParser · 综合场景', () => {
  it('full scene with scratch + dialogue + bg/sprite + 跨 chunk', () => {
    const SRC =
      `<scratch>思考：先换场景到 cafe。</scratch>` +
      `<narration>` +
      `<background scene="cafe_interior"/>` +
      `<sprite char="sakuya" mood="smile" position="center"/>` +
      `咖啡店，阳光正好。` +
      `</narration>` +
      `<dialogue speaker="sakuya" to="mc">` +
      `你来了。` +
      `</dialogue>` +
      `<dialogue speaker="mc" to="sakuya">` +
      `嗯，抱歉我迟到了。` +
      `</dialogue>` +
      `<narration>` +
      `<stage/>` +
      `气氛变得安静。` +
      `</narration>`;

    const p = makeParser();
    const { sentences, scratches, degrades } = feedInChunks(p, SRC, 7);

    expect(scratches).toHaveLength(1);
    expect(sentences).toHaveLength(4);
    expect(sentences.map((s) => s.kind)).toEqual([
      'narration',
      'dialogue',
      'dialogue',
      'narration',
    ]);
    expect(sentences.map((s) => s.index)).toEqual([1, 2, 3, 4]);
    expect(scratches[0]!.index).toBe(0);
    expect(sentences[0]!.sceneRef.background).toBe('cafe_interior');
    // 简化版：narration 不显示立绘，<sprite> 子标签被忽略
    expect(sentences[0]!.sceneRef.sprites).toEqual([]);
    // dialogue sakuya → 立绘 = sakuya@center
    expect(sentences[1]!.sceneRef.sprites).toEqual([
      { id: 'sakuya', emotion: 'neutral', position: 'center' },
    ]);
    // dialogue mc → 立绘换为 mc@center（不并存）
    expect(sentences[2]!.sceneRef.sprites).toEqual([
      { id: 'mc', emotion: 'neutral', position: 'center' },
    ]);
    // 最后 narration → 立绘退场
    expect(sentences[3]!.sceneRef.sprites).toEqual([]);
    expect(sentences[3]!.sceneRef.background).toBe('cafe_interior'); // bg 继承
    expect(degrades).toHaveLength(0);
  });
});
