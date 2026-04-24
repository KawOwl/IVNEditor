/**
 * findNarrationCut —— 旁白切分策略
 *
 * 覆盖：
 *   1. 段落边界 \n\n 优先
 *   2. 软阈值触发时找句末标点（中/英文）
 *   3. 硬上限兜底切任意收束字符
 *   4. 没到阈值 + 无段落边界 → 返回 null（继续累积）
 */

import { describe, it, expect } from 'bun:test';
import {
  findNarrationCut,
  NARRATION_SOFT_LIMIT,
  NARRATION_HARD_LIMIT,
} from '../game-session';

describe('findNarrationCut', () => {
  it('短文本无段落边界 → null（继续累积）', () => {
    expect(findNarrationCut('你走向广场边缘。')).toBeNull();
    expect(findNarrationCut('')).toBeNull();
  });

  it('\\n\\n 是第一优先切分点（即使文本很短）', () => {
    const input = 'para1\n\npara2';
    const cut = findNarrationCut(input);
    expect(cut).not.toBeNull();
    expect(cut!.end).toBe(5);
    expect(cut!.consume).toBe(7);
    expect(input.slice(0, cut!.end)).toBe('para1');
    expect(input.slice(cut!.consume)).toBe('para2');
  });

  it('软阈值以下不切（哪怕有句末）', () => {
    const input = '短短一句。然后继续短短两句。' + 'x'.repeat(50);
    expect(input.length).toBeLessThan(NARRATION_SOFT_LIMIT);
    expect(findNarrationCut(input)).toBeNull();
  });

  it('超过软阈值 → 从 0.7*SOFT 后找第一个句末标点切', () => {
    // 构造一段超过软阈值的文本，里面有多个句号
    const seg = '这是一段测试文本，用来验证切分逻辑。';  // 包含 。
    let buf = '';
    while (buf.length < NARRATION_SOFT_LIMIT + 50) buf += seg;
    const cut = findNarrationCut(buf);
    expect(cut).not.toBeNull();
    // 切点应在 0.7*SOFT 之后、在 SOFT+50 之前
    expect(cut!.end).toBeGreaterThan(Math.floor(NARRATION_SOFT_LIMIT * 0.7));
    // 切出的 Sentence 末尾必须是句末标点（。 之类）
    const cutText = buf.slice(0, cut!.end);
    const lastCh = cutText[cutText.length - 1];
    expect(['。', '！', '？', '.', '!', '?']).toContain(lastCh);
  });

  it('超过硬上限但全是无句末字符 → 按弱收束（逗号等）切', () => {
    // 制造没有句末但有逗号的超长文本
    let buf = '';
    const seg = '段不带句号的文字，';  // 带中文逗号
    while (buf.length < NARRATION_HARD_LIMIT + 50) buf += seg;
    const cut = findNarrationCut(buf);
    expect(cut).not.toBeNull();
    expect(cut!.end).toBeGreaterThan(Math.floor(NARRATION_HARD_LIMIT * 0.7));
    const cutText = buf.slice(0, cut!.end);
    const lastCh = cutText[cutText.length - 1];
    // 末尾应该是一个收束字符
    expect(['。', '！', '？', '.', '!', '?', '，', '；', ',', ';', '\n', ' ']).toContain(lastCh);
  });

  it('英文句号能匹配', () => {
    const seg = 'This is a sentence. ';
    let buf = '';
    while (buf.length < NARRATION_SOFT_LIMIT + 30) buf += seg;
    const cut = findNarrationCut(buf);
    expect(cut).not.toBeNull();
    const cutText = buf.slice(0, cut!.end);
    expect(cutText.endsWith('.')).toBe(true);
  });

  it('切分后 consume === end（无换行等分隔符消耗）', () => {
    let buf = '';
    const seg = '短句。';
    while (buf.length < NARRATION_SOFT_LIMIT + 20) buf += seg;
    const cut = findNarrationCut(buf)!;
    expect(cut.consume).toBe(cut.end);
  });

  it('\\n\\n 切分：consume = end + 2（丢掉两个换行）', () => {
    const input = 'hello\n\nworld';
    const cut = findNarrationCut(input)!;
    expect(cut.consume - cut.end).toBe(2);
  });
});
