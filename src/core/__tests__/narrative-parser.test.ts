/**
 * NarrativeParser 单元测试
 *
 * 关键覆盖：
 *   - 完整输入一次性解析
 *   - 分块输入逐 chunk 解析（模拟流式）
 *   - 末尾截断（未闭合 <d>）→ truncated 标记
 *   - 属性格式变体（短名/长名、引号、多值）
 *   - 嵌套/混合 narration + dialogue
 *   - 坏 tag 降级
 *   - 参与框架字段齐全
 */

import { describe, it, expect } from 'bun:test';
import { NarrativeParser, parseDialogueAttrs } from '../narrative-parser';
import type { ParticipationFrame } from '../types';

interface Event {
  type: 'narration' | 'd_start' | 'd_chunk' | 'd_end';
  text?: string;
  pf?: ParticipationFrame;
  truncated?: boolean;
}

/** 把 parser 事件收集进数组，便于 assert */
function collect(): { parser: NarrativeParser; events: Event[] } {
  const events: Event[] = [];
  const parser = new NarrativeParser({
    onNarrationChunk: (text) => events.push({ type: 'narration', text }),
    onDialogueStart: (pf) => events.push({ type: 'd_start', pf }),
    onDialogueChunk: (text) => events.push({ type: 'd_chunk', text }),
    onDialogueEnd: (pf, fullText, truncated) =>
      events.push({ type: 'd_end', pf, text: fullText, truncated }),
  });
  return { parser, events };
}

// ============================================================================
// 1. 基础完整输入
// ============================================================================

describe('NarrativeParser · 基础', () => {
  it('只有旁白', () => {
    const { parser, events } = collect();
    parser.push('黄昏的教室里只剩下她一个人。');
    parser.finalize();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'narration', text: '黄昏的教室里只剩下她一个人。' });
  });

  it('纯旁白多 chunk 流式喂入时，在 push 时就 emit 出来（不等 finalize）', () => {
    // Regression：历史上 parser 在完全无 XML tag 的流里，narrationBuffer 一直攒到
    // finalize() 才 flush，导致 VN UI 在 signal_input_needed 挂起前什么叙事都没
    // 看到，玩家只看到选项（见 trace 7e163edc-...）。
    const { parser, events } = collect();
    parser.push('你走向广场边缘。');
    // 至少要 emit 出 narration，别等到 finalize 才吐
    expect(events.filter(e => e.type === 'narration').length).toBeGreaterThan(0);
    parser.push('阳光穿过树叶，在地上投下斑驳的光影。');
    expect(events.filter(e => e.type === 'narration').length).toBeGreaterThan(1);
    parser.finalize();
    // finalize 后所有 narration 都应该已经 emit，且总内容完整
    const allNarration = events.filter(e => e.type === 'narration').map(e => e.text).join('');
    expect(allNarration).toContain('你走向广场边缘');
    expect(allNarration).toContain('阳光穿过树叶');
  });

  it('只有对话', () => {
    const { parser, events } = collect();
    parser.push('<d s="sakuya" to="player">欢迎光临</d>');
    parser.finalize();
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: 'd_start' });
    expect(events[0].pf).toEqual({
      speaker: 'sakuya',
      addressee: ['player'],
    });
    expect(events[1]).toMatchObject({ type: 'd_chunk', text: '欢迎光临' });
    expect(events[2]).toMatchObject({ type: 'd_end', truncated: false });
    expect(events[2].text).toBe('欢迎光临');
  });

  it('旁白 + 对话 + 旁白混合', () => {
    const { parser, events } = collect();
    parser.push('她看着窗外。\n\n<d s="aonkei">我该走了。</d>\n\n她转身离开。');
    parser.finalize();
    const kinds = events.map((e) => e.type);
    expect(kinds).toEqual(['narration', 'd_start', 'd_chunk', 'd_end', 'narration']);
    expect(events[0]!.text).toContain('她看着窗外');
    expect(events[1]!.pf?.speaker).toBe('aonkei');
    expect(events[4]!.text).toContain('她转身离开');
  });

  it('多个对话连续', () => {
    const { parser, events } = collect();
    parser.push('<d s="a" to="b">第一句</d><d s="b" to="a">第二句</d>');
    parser.finalize();
    const dEnds = events.filter((e) => e.type === 'd_end');
    expect(dEnds).toHaveLength(2);
    expect(dEnds[0]!.text).toBe('第一句');
    expect(dEnds[1]!.text).toBe('第二句');
  });
});

// ============================================================================
// 2. 流式分块
// ============================================================================

describe('NarrativeParser · 流式分块', () => {
  it('对话文字分多个 chunk 到达', () => {
    const { parser, events } = collect();
    parser.push('<d s="sakuya" to="player">');
    parser.push('你');
    parser.push('好');
    parser.push('吗？');
    parser.push('</d>');
    parser.finalize();

    const dChunks = events.filter((e) => e.type === 'd_chunk').map((e) => e.text);
    expect(dChunks.join('')).toBe('你好吗？');
    const dEnd = events.find((e) => e.type === 'd_end');
    expect(dEnd?.text).toBe('你好吗？');
    expect(dEnd?.truncated).toBe(false);
  });

  it('tag 开标签跨 chunk 切分', () => {
    const { parser, events } = collect();
    parser.push('<d s="');
    parser.push('sakuya" to="pl');
    parser.push('ayer">你好</d>');
    parser.finalize();

    const start = events.find((e) => e.type === 'd_start');
    expect(start?.pf?.speaker).toBe('sakuya');
    expect(start?.pf?.addressee).toEqual(['player']);
  });

  it('<d> 和 </d> 各在不同 chunk', () => {
    const { parser, events } = collect();
    parser.push('旁白片段 ');
    parser.push('<d s="x">你好');
    parser.push('，世界');
    parser.push('</d>');
    parser.push(' 又一段旁白');
    parser.finalize();

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('narration');
    expect(types).toContain('d_start');
    expect(types).toContain('d_end');
    expect(types[types.length - 1]).toBe('narration');
  });

  it('<" 跨 chunk 但实际是旁白的 <', () => {
    const { parser, events } = collect();
    parser.push('剩余 <');
    parser.push(' 50 元'); // "< 50" 不是 tag 起始
    parser.finalize();

    // 坏 tag 降级：< 之后紧跟空格或数字，应该当旁白
    const narrText = events
      .filter((e) => e.type === 'narration')
      .map((e) => e.text)
      .join('');
    expect(narrText).toContain('剩余');
    expect(narrText).toContain('50 元');
  });
});

// ============================================================================
// 3. 末尾降级闭合
// ============================================================================

describe('NarrativeParser · 末尾降级', () => {
  it('未闭合的 <d> 在 finalize 时应自动闭合并 truncated=true', () => {
    const { parser, events } = collect();
    parser.push('<d s="sakuya" to="player">这句话被截断了');
    parser.finalize();

    const dEnd = events.find((e) => e.type === 'd_end');
    expect(dEnd).toBeDefined();
    expect(dEnd?.truncated).toBe(true);
    expect(dEnd?.text).toBe('这句话被截断了');
    expect(dEnd?.pf?.speaker).toBe('sakuya');
  });

  it('已闭合的 <d> 应 truncated=false', () => {
    const { parser, events } = collect();
    parser.push('<d s="x">完整</d>');
    parser.finalize();
    const dEnd = events.find((e) => e.type === 'd_end');
    expect(dEnd?.truncated).toBe(false);
  });

  it('<d 标签未写完就截断 → 什么都不产生（不崩）', () => {
    const { parser, events } = collect();
    parser.push('<d s="sakuya"');
    parser.finalize();
    // 没 d_start / d_end；可能有旁白也可能没
    const dEnds = events.filter((e) => e.type === 'd_end');
    expect(dEnds).toHaveLength(0);
  });

  it('流只有一个 <', () => {
    const { parser, events } = collect();
    parser.push('<');
    parser.finalize();
    // 孤悬 < 降级为旁白
    const narrText = events
      .filter((e) => e.type === 'narration')
      .map((e) => e.text)
      .join('');
    expect(narrText).toBe('<');
  });
});

// ============================================================================
// 4. 参与框架解析
// ============================================================================

describe('parseDialogueAttrs · PF 字段', () => {
  it('基础 speaker + addressee', () => {
    const pf = parseDialogueAttrs('s="sakuya" to="player"');
    expect(pf).toEqual({ speaker: 'sakuya', addressee: ['player'] });
  });

  it('多受话人逗号分隔', () => {
    const pf = parseDialogueAttrs('s="teacher" to="yuki,nanami"');
    expect(pf.addressee).toEqual(['yuki', 'nanami']);
  });

  it('广播 to="*"', () => {
    const pf = parseDialogueAttrs('s="principal" to="*"');
    expect(pf.addressee).toEqual(['*']);
  });

  it('overhearer + eavesdropper', () => {
    const pf = parseDialogueAttrs(
      's="aonkei" to="sakuya" hear="teacher" eav="spy,agent"',
    );
    expect(pf).toEqual({
      speaker: 'aonkei',
      addressee: ['sakuya'],
      overhearers: ['teacher'],
      eavesdroppers: ['spy', 'agent'],
    });
  });

  it('只有 speaker（独白）', () => {
    const pf = parseDialogueAttrs('s="sakuya"');
    expect(pf.speaker).toBe('sakuya');
    expect(pf.addressee).toBeUndefined();
  });

  it('属性名长短混用（容错）', () => {
    const pf = parseDialogueAttrs('speaker="x" addressee="y"');
    expect(pf).toEqual({ speaker: 'x', addressee: ['y'] });
  });

  it('引号变体（单引号 / 无引号）', () => {
    expect(parseDialogueAttrs("s='a' to='b'").speaker).toBe('a');
    expect(parseDialogueAttrs('s=sakuya').speaker).toBe('sakuya');
  });

  it('属性顺序任意', () => {
    const pf = parseDialogueAttrs('eav="spy" to="player" s="sakuya"');
    expect(pf.speaker).toBe('sakuya');
    expect(pf.eavesdroppers).toEqual(['spy']);
  });

  it('空 attrs 时 speaker 降级为 unknown', () => {
    const pf = parseDialogueAttrs('');
    expect(pf.speaker).toBe('unknown');
  });

  it('多余空白和逗号 trim', () => {
    const pf = parseDialogueAttrs('s="x" to=" a , b , c "');
    expect(pf.addressee).toEqual(['a', 'b', 'c']);
  });
});

// ============================================================================
// 5. 跳过未知 tag（<scene> / <spr/> 等）
// ============================================================================

describe('NarrativeParser · 未知 tag', () => {
  it('<scene> 及其属性应被跳过，不影响旁白/对话流', () => {
    const { parser, events } = collect();
    parser.push(
      '<scene bg="classroom" fx="fade"><spr id="aonkei" em="smile"/></scene>\n\n',
    );
    parser.push('夕阳西下。\n\n<d s="aonkei">你来了。</d>');
    parser.finalize();

    const narrText = events
      .filter((e) => e.type === 'narration')
      .map((e) => e.text)
      .join('');
    expect(narrText).toContain('夕阳西下');
    expect(narrText).not.toContain('<scene');
    expect(narrText).not.toContain('<spr');

    const dEnd = events.find((e) => e.type === 'd_end');
    expect(dEnd?.pf?.speaker).toBe('aonkei');
    expect(dEnd?.text).toBe('你来了。');
  });

  it('自闭合 <spr/> 正常跳过', () => {
    const { parser, events } = collect();
    parser.push('<spr id="x" em="y"/>旁白文字');
    parser.finalize();
    const narrText = events
      .filter((e) => e.type === 'narration')
      .map((e) => e.text)
      .join('');
    expect(narrText).toBe('旁白文字');
  });
});

// ============================================================================
// 6. 极端输入
// ============================================================================

describe('NarrativeParser · 极端输入', () => {
  it('空输入', () => {
    const { parser, events } = collect();
    parser.finalize();
    expect(events).toHaveLength(0);
  });

  it('极长旁白（确保不爆栈）', () => {
    const { parser, events } = collect();
    const longText = 'a'.repeat(5000);
    parser.push(longText);
    parser.finalize();
    const narrText = events
      .filter((e) => e.type === 'narration')
      .map((e) => e.text)
      .join('');
    expect(narrText.length).toBe(5000);
  });

  it('逐字符 push（极端分块）', () => {
    const { parser, events } = collect();
    const input = '旁白<d s="x">对话</d>尾巴';
    for (const ch of input) parser.push(ch);
    parser.finalize();
    const dEnd = events.find((e) => e.type === 'd_end');
    expect(dEnd?.text).toBe('对话');
    const allNarration = events
      .filter((e) => e.type === 'narration')
      .map((e) => e.text)
      .join('');
    expect(allNarration).toBe('旁白尾巴');
  });
});
