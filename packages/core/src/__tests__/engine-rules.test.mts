/**
 * engine-rules.ts 单元测试
 *
 * 覆盖目标：
 *   1. v2 字节稳定 snapshot：buildEngineRules 输出（with 固定 manifest）的 hash
 *      被冻结，未来任何 prompt 文本改动都会让测试失败 → 强制 commit message
 *      解释为什么改 + 同步更新 snapshot。这跟 prompt cache 命中率挂钩——
 *      生产环境前缀稳定才能复用 cache。
 *   2. 关键内容守门：v2 必须包含的核心规则（容器规范 / __npc__ ad-hoc /
 *      三档分级 / 反面示范 / 视觉子标签）—— 这些是 LLM 行为正确性的硬底线，
 *      不能被误删或漂移。
 *   3. 白名单插值：char / mood / bg id 正确插入 + 空白名单显式占位。
 *
 * legacy v1（XML-lite \`<d>\` 协议）prompt 文本 2026-04-26 已删除—— ProtocolVersion
 * 仍保留 'v1-tool-call' 成员供 runtime 协议守门用，但 prompt 文本不再产出。
 */

import { describe, it, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { buildEngineRules } from '#internal/engine-rules';

function hash(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

describe('buildEngineRules', () => {
  // ==========================================================================
  // 字节稳定 snapshot（prompt cache 友好）
  // ==========================================================================

  it('v2 空 manifest 输出字节稳定 (snapshot hash)', () => {
    const text = buildEngineRules({ characters: [], backgrounds: [] });
    // 字节快照——任何 prompt 子段改动都会让 hash 变。改动时同步更新此值，
    // commit message 必须解释为什么改。
    expect(hash(text)).toBe(
      '7ba267ce0352e1dd5eadf743567e70a772c1a48521cc353bad404744ab368148',
    );
    expect(text.length).toBe(9034);
  });

  it('v2 with sample manifest 输出字节稳定 (snapshot hash)', () => {
    const text = buildEngineRules({
      characters: [
        { id: 'sakuya', sprites: [{ id: 'smiling' }, { id: 'thinking' }] },
        { id: 'aonkei', sprites: [{ id: 'neutral' }] },
      ],
      backgrounds: [{ id: 'classroom_evening' }, { id: 'classroom_night' }],
    });
    expect(hash(text)).toBe(
      'fdfafeccc4cfe88ad0a04fe33587863134ab2f40752fa9e8692a6f0ab13df2fe',
    );
    expect(text.length).toBe(9093);
  });

  // ==========================================================================
  // 关键内容守门
  // ==========================================================================

  it('包含 prologue（GM 身份 / 回合收尾 / signal_input / end_scenario）', () => {
    const text = buildEngineRules();
    expect(text).toContain('[ENGINE RULES]');
    expect(text).toContain('signal_input_needed');
    expect(text).toContain('end_scenario');
    expect(text).toContain('回合收尾规则');
  });

  it('包含 v2 三种顶层容器规范（dialogue / narration / scratch）', () => {
    const text = buildEngineRules();
    expect(text).toContain('<dialogue');
    expect(text).toContain('<narration>');
    expect(text).toContain('<scratch>');
    expect(text).toContain('玩家看不到');  // scratch 解释
  });

  it('包含 v2 视觉子标签 + 继承规则四条', () => {
    const text = buildEngineRules();
    expect(text).toContain('<background');
    expect(text).toContain('<sprite ');
    expect(text).toContain('<stage />');
    expect(text).toContain('省略');
    expect(text).toContain('替换');
    expect(text).toContain('清除');
    expect(text).toContain('完全不变');
  });

  it('禁止整轮只 <scratch>（防玩家屏幕空白）', () => {
    const text = buildEngineRules();
    expect(text).toMatch(/每轮.*至少.*一个.*<dialogue>.*<narration>/);
    expect(text).toMatch(/整轮只有.*<scratch>|整轮只输出.*<scratch>/);
    expect(text).toContain('屏幕一片空白');
  });

  it('禁止调用旧视觉工具（change_scene / change_sprite / clear_stage）', () => {
    const text = buildEngineRules();
    expect(text).toContain('change_scene');
    expect(text).toContain('change_sprite');
    expect(text).toContain('clear_stage');
    expect(text).toMatch(/不要.*change_scene/);
  });

  it('明确 <dialogue> 正文只装直接引语，旁白动作走 <narration>', () => {
    const text = buildEngineRules();
    expect(text).toContain('直接引语');
    // 反例 / 正例配对
    expect(text).toContain('俄罗斯');
    expect(text).toContain('大拇指');
    expect(text).toMatch(/<dialogue[^>]*>\s*"俄罗斯？"他用大拇指/);
    expect(text).toMatch(/<narration>\s*他用大拇指/);
  });

  // ==========================================================================
  // __npc__ ad-hoc speaker 三档分级（改进 A，trace 227cb1d0 触发）
  // ==========================================================================

  it('__npc__ ad-hoc 约定 + 反伪装守卫 + 具体例子', () => {
    const text = buildEngineRules({
      characters: [{ id: 'sakuya', sprites: [{ id: 'smiling' }] }],
      backgrounds: [{ id: 'classroom' }],
    });
    expect(text).toContain('__npc__');
    expect(text).toContain('非白名单');
    expect(text).toMatch(/<dialogue\s+speaker="__npc__/);
    expect(text).toMatch(/禁止.*伪装|白名单内角色必须用对应 id/);
  });

  it('__npc__ 三档分级（推荐 / 可接受 / 禁止）', () => {
    const text = buildEngineRules();
    expect(text).toContain('推荐');
    expect(text).toContain('可接受但不理想');
    expect(text).toContain('禁止');
    // 三档分别带例子
    expect(text).toContain('__npc__保安');         // ✅ 具体身份
    expect(text).toContain('__npc__陌生男声');     // ⚠️ 声音形容
    // ❌ 关系代词 / 泛指列表（trace 227cb1d0 触发的扩展）
    for (const banned of ['另一人', '某人', '其中一个', '那个人', '谁']) {
      expect(text).toContain(banned);
    }
    // 跟 reducer 对齐的代词列表
    for (const pronoun of ['你', '我', '他', '她', '它', '他们', '她们', '咱', '自己', '主角']) {
      expect(text).toContain(pronoun);
    }
  });

  it('反面示范含"代词当 ad-hoc"+ "关系代词当 ad-hoc"两对 ❌→✅', () => {
    const text = buildEngineRules();
    expect(text).toMatch(/__npc__你/);
    expect(text).toMatch(/to="player"/);
    expect(text).toMatch(/正文|narration.*你|你.*narration/);
    expect(text).toMatch(/__npc__另一人/);
    expect(text).toMatch(/另一个声音/);
  });

  // ==========================================================================
  // 白名单插值
  // ==========================================================================

  it('空白名单显示"（剧本未定义任何 X）"占位', () => {
    const text = buildEngineRules({ characters: [], backgrounds: [] });
    expect(text).toContain('（剧本未定义任何背景）');
    expect(text).toContain('（剧本未定义任何角色）');
    expect(text).toContain('（剧本未定义任何角色 / 情绪）');
  });

  it('非空白名单正确插入 char / mood / bg id', () => {
    const text = buildEngineRules({
      characters: [
        { id: 'sakuya', sprites: [{ id: 'smiling' }, { id: 'thinking' }] },
        { id: 'aonkei', sprites: [{ id: 'neutral' }] },
      ],
      backgrounds: [{ id: 'classroom_evening' }, { id: 'classroom_night' }],
    });
    expect(text).toContain('classroom_evening, classroom_night');
    expect(text).toContain('sakuya, aonkei');
    expect(text).toContain('- sakuya: smiling, thinking');
    expect(text).toContain('- aonkei: neutral');
  });

  it('sprites 为空的角色显示"（该角色未定义情绪）"', () => {
    const text = buildEngineRules({
      characters: [{ id: 'ghost', sprites: [] }],
      backgrounds: [{ id: 'void' }],
    });
    expect(text).toContain('- ghost: （该角色未定义情绪）');
  });

  it('白名单变化影响输出（插值不是 no-op）', () => {
    const a = buildEngineRules({
      characters: [{ id: 'alice', sprites: [{ id: 'happy' }] }],
      backgrounds: [{ id: 'park' }],
    });
    const b = buildEngineRules({
      characters: [{ id: 'bob', sprites: [{ id: 'sad' }] }],
      backgrounds: [{ id: 'office' }],
    });
    expect(a).not.toBe(b);
    expect(a).toContain('alice');
    expect(a).not.toContain('bob');
    expect(b).toContain('bob');
    expect(b).not.toContain('alice');
  });
});
