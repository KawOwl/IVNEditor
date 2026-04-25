/**
 * 叙事流水线集成测试
 *
 * 验证"LLM 流式吐文字 → NarrativeParser → createNarrationAccumulator → 段落级
 * Sentence"这条完整链路，模拟真实玩游戏时的切分行为。
 *
 * 和下面两个兄弟 test 互补：
 *   - narrative-parser.test.ts  只测 parser 的 XML-lite 解析
 *   - narration-cut.test.ts     只测 findNarrationCut 这个纯函数
 *   - 本文件（集成）测的是两者拼起来之后的"LLM chunk 进 → paragraph Sentence 出"
 */

import { describe, it, expect } from 'bun:test';
import { NarrativeParser } from '#internal/narrative-parser';
import { createNarrationAccumulator, NARRATION_SOFT_LIMIT, NARRATION_HARD_LIMIT } from '#internal/game-session';

/**
 * 把 raw text 按 N 字切成 chunk，模拟流式 LLM 的 onTextChunk 调用。
 */
function feedChunks(raw: string, chunkSize: number, onNarration: (t: string) => void, onDialogueEnd?: (pf: { speaker: string }, text: string) => void) {
  const accumulator = createNarrationAccumulator(onNarration);
  const parser = new NarrativeParser({
    onNarrationChunk: (text) => accumulator.push(text),
    // 和生产代码一样：dialogue 开始前 flush 掉累积的 narration，保证顺序
    onDialogueStart: () => accumulator.flush(),
    onDialogueEnd: (pf, text) => onDialogueEnd?.(pf, text),
  });
  for (let i = 0; i < raw.length; i += chunkSize) {
    parser.push(raw.slice(i, i + chunkSize));
  }
  parser.finalize();
  accumulator.flush();
}

describe('narration pipeline · parser + accumulator', () => {
  it('短纯旁白（无 XML，< 软阈值）→ 1 条 Sentence', () => {
    const out: string[] = [];
    feedChunks('黄昏的教室里只剩下她一个人。', 10, (t) => out.push(t));
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('黄昏的教室里只剩下她一个人');
  });

  it('两段旁白 \\n\\n 分隔 → 2 条 Sentence（按段落切）', () => {
    const raw = '彩纸在空中飘散。\n\n你站在人群边缘。';
    const out: string[] = [];
    feedChunks(raw, 8, (t) => out.push(t));
    expect(out).toHaveLength(2);
    expect(out[0]).toBe('彩纸在空中飘散。');
    expect(out[1]).toBe('你站在人群边缘。');
  });

  it('长旁白（超软阈值，无段落边界）→ 按句末切成多条 Sentence', () => {
    // 构造一段超过软阈值的、全是中文句号分隔的纯旁白
    const seg = '这是一句测试文本，用于验证切分逻辑是否按句末对齐。';
    let raw = '';
    while (raw.length < NARRATION_SOFT_LIMIT * 2.5) raw += seg;
    const out: string[] = [];
    feedChunks(raw, 15, (t) => out.push(t));
    expect(out.length).toBeGreaterThanOrEqual(2);
    // 每条 Sentence 长度都应该 ≤ HARD 上限 + 一个 seg 的余量
    // （findNarrationCut 在 SOFT 到 HARD 之间找，最大不会超 HARD）
    for (const s of out) {
      expect(s.length).toBeLessThanOrEqual(NARRATION_HARD_LIMIT + seg.length);
      // 每条都应以句末标点结束（除最后一条可能是 finalize flush 的）
    }
    // 所有段拼起来应覆盖全部原文（去掉空白差异）
    const joined = out.join('').replace(/\s/g, '');
    const expected = raw.replace(/\s/g, '');
    expect(joined).toBe(expected);
  });

  it('混 XML 对话 + 纯旁白 → 正确分出 narration / dialogue 的 Sentence', () => {
    const raw = '她走进房间。\n\n<d s="alice" to="bob">你来了。</d>\n\n他点点头。';
    const narrations: string[] = [];
    const dialogues: { speaker: string; text: string }[] = [];
    feedChunks(
      raw,
      10,
      (t) => narrations.push(t),
      (pf, text) => dialogues.push({ speaker: pf.speaker, text }),
    );
    expect(narrations).toHaveLength(2);
    expect(narrations[0]).toBe('她走进房间。');
    expect(narrations[1]).toBe('他点点头。');
    expect(dialogues).toHaveLength(1);
    expect(dialogues[0]!.speaker).toBe('alice');
    expect(dialogues[0]!.text).toBe('你来了。');
  });

  it('LLM 吐大段无换行长叙事（模拟真实坏 case）→ 被切成多段而不是一坨', () => {
    // 构造 1000 字的纯旁白，句号分隔但没换行
    const seg = '夕阳透过拱形窗斜射进来，在两层高的书墙上投下长长的影子。';
    let raw = '';
    while (raw.length < 1000) raw += seg;
    const out: string[] = [];
    feedChunks(raw, 20, (t) => out.push(t));
    // 至少切成 2 段（不会一坨 1000 字）
    expect(out.length).toBeGreaterThanOrEqual(2);
    // 每段都 ≤ HARD 上限 + 一个 seg 的余量
    for (const s of out) {
      expect(s.length).toBeLessThanOrEqual(NARRATION_HARD_LIMIT + seg.length);
    }
    // 总内容无损
    const joined = out.join('').replace(/\s/g, '');
    const expected = raw.replace(/\s/g, '');
    expect(joined).toBe(expected);
  });

  it('flush 触发：中途没满足切分条件，finalize+flush 把剩余推出', () => {
    // 只写半句没句号
    const raw = '黄昏的教室里只剩下她一';
    const out: string[] = [];
    feedChunks(raw, 5, (t) => out.push(t));
    expect(out).toHaveLength(1);
    expect(out[0]).toBe('黄昏的教室里只剩下她一');
  });

  it('dialogue 之间的旁白会分别被 flush（不会跨 dialogue 拼起来）', () => {
    const raw = 'A 说前。\n\n<d s="a">hi</d>\n\nA 说后。';
    const nn: string[] = [];
    const dd: string[] = [];
    feedChunks(raw, 7, (t) => nn.push(t), (_pf, text) => dd.push(text));
    expect(nn).toEqual(['A 说前。', 'A 说后。']);
    expect(dd).toEqual(['hi']);
  });
});
