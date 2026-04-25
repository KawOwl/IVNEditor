/**
 * engine-rules.ts 单元测试（V.3）
 *
 * 覆盖目标：
 *   1. 当前协议为缺省运行规则；v1 字节回归显式通过 'v1-tool-call' 保留。
 *   2. v1 和 v2 共享的 prologue / epilogue 保持字节一致（不干扰 prompt 缓存
 *      命中率 —— 前缀稳定是关键）。
 *   3. v2 白名单插值：
 *      - 非空白名单把 char / mood / bg id 正确拼进 prompt
 *      - 空白名单显示 "（剧本未定义任何 X）" 而不是裸分隔符
 *   4. v2 必须包含 RFC §12.1.1 规定的"非白名单 NPC 转写到 `<narration>`"硬性规则文本，
 *      否则回到最早的 Shape C bug（LLM 拿白名单外的 speaker 去做 dialog 导致 parser 降级）。
 *   5. v2 必须显式禁止调用 change_scene / change_sprite / clear_stage 工具（RFC §3.2 视觉子标签唯一通道）。
 */

import { describe, it, expect } from 'bun:test';
import { buildEngineRules, ENGINE_RULES_CONTENT } from '#internal/engine-rules';

describe('buildEngineRules', () => {
  it('缺省 protocolVersion === 当前声明式协议', () => {
    const text = buildEngineRules();
    expect(text).not.toBe(ENGINE_RULES_CONTENT);
    expect(text).toContain('<narration>');
    expect(text).toContain('<background');
    expect(text).toMatch(/不要.*change_scene/);
  });

  it('v1-tool-call 显式传入，输出和 ENGINE_RULES_CONTENT 字节一致', () => {
    const text = buildEngineRules({ protocolVersion: 'v1-tool-call' });
    expect(text).toBe(ENGINE_RULES_CONTENT);
  });

  it('v1 输出包含原 XML-lite `<d>` 叙事格式头（防意外移除 / 改名）', () => {
    // 老 prompt 里的标志性段落 —— 任何版本切换都不能在 v1 里把它吃掉
    expect(ENGINE_RULES_CONTENT).toContain('<d ');
  });

  it('v1 和 v2 共享 prologue（"身份与职责" / "回合收尾" 在两版里都存在且等同）', () => {
    const v1 = buildEngineRules({ protocolVersion: 'v1-tool-call' });
    const v2 = buildEngineRules({
      protocolVersion: 'v2-declarative-visual',
      characters: [],
      backgrounds: [],
    });
    // 两版都应该以同一段 GM 身份介绍开头（prompt cache 友好）
    // 取前 500 字符做前缀比对，避免把 v2 的 narrative 段扯进来
    expect(v1.slice(0, 500)).toBe(v2.slice(0, 500));
  });

  it('v2 空白名单显示"（剧本未定义任何 X）"占位，不生成裸冒号', () => {
    const text = buildEngineRules({
      protocolVersion: 'v2-declarative-visual',
      characters: [],
      backgrounds: [],
    });
    expect(text).toContain('（剧本未定义任何背景）');
    expect(text).toContain('（剧本未定义任何角色）');
    expect(text).toContain('（剧本未定义任何角色 / 情绪）');
  });

  it('v2 非空白名单正确插入 char / mood / bg id', () => {
    const text = buildEngineRules({
      protocolVersion: 'v2-declarative-visual',
      characters: [
        {
          id: 'sakuya',
          sprites: [{ id: 'smiling' }, { id: 'thinking' }],
        },
        {
          id: 'aonkei',
          sprites: [{ id: 'neutral' }],
        },
      ],
      backgrounds: [{ id: 'classroom_evening' }, { id: 'classroom_night' }],
    });

    // 背景 / 角色 id 行
    expect(text).toContain('classroom_evening, classroom_night');
    expect(text).toContain('sakuya, aonkei');
    // 每角色情绪行
    expect(text).toContain('- sakuya: smiling, thinking');
    expect(text).toContain('- aonkei: neutral');
  });

  it('v2 sprites 为空的角色 → 显示"（该角色未定义情绪）"', () => {
    const text = buildEngineRules({
      protocolVersion: 'v2-declarative-visual',
      characters: [{ id: 'ghost', sprites: [] }],
      backgrounds: [{ id: 'void' }],
    });
    expect(text).toContain('- ghost: （该角色未定义情绪）');
  });

  it('v2 必须包含"非白名单角色转写到 <narration>"硬性规则（RFC §12.1.1 Shape C 补丁）', () => {
    const text = buildEngineRules({
      protocolVersion: 'v2-declarative-visual',
      characters: [{ id: 'sakuya', sprites: [{ id: 'smiling' }] }],
      backgrounds: [{ id: 'classroom' }],
    });
    // 关键指令：path B 的强化
    expect(text).toContain('非白名单');
    expect(text).toContain('<narration>');
    // 老 v2 bug 的根源：LLM 把 NPC 塞进 speaker 属性
    expect(text).toMatch(/不要.*塞进.*dialogue speaker/);
  });

  it('v2 必须禁止调用旧视觉工具（change_scene / change_sprite / clear_stage）', () => {
    const text = buildEngineRules({
      protocolVersion: 'v2-declarative-visual',
      characters: [],
      backgrounds: [],
    });
    expect(text).toContain('change_scene');
    expect(text).toContain('change_sprite');
    expect(text).toContain('clear_stage');
    // 明确禁令措辞
    expect(text).toMatch(/不要.*change_scene/);
  });

  it('v2 必须包含 <scratch> 解释（LLM 元叙述出口）', () => {
    const text = buildEngineRules({
      protocolVersion: 'v2-declarative-visual',
      characters: [],
      backgrounds: [],
    });
    expect(text).toContain('<scratch>');
    expect(text).toContain('玩家看不到');
  });

  it('v2 必须包含继承规则四条（省略背景 / sprite 替换 / stage 清空 / 都无保持不变）', () => {
    const text = buildEngineRules({
      protocolVersion: 'v2-declarative-visual',
      characters: [],
      backgrounds: [],
    });
    expect(text).toContain('省略');
    expect(text).toContain('替换');
    expect(text).toContain('清除');
    expect(text).toContain('完全不变');
  });

  it('v2 白名单变化影响输出（插值不是 no-op）', () => {
    const a = buildEngineRules({
      protocolVersion: 'v2-declarative-visual',
      characters: [{ id: 'alice', sprites: [{ id: 'happy' }] }],
      backgrounds: [{ id: 'park' }],
    });
    const b = buildEngineRules({
      protocolVersion: 'v2-declarative-visual',
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
