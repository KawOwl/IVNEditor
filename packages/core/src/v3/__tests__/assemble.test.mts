import { describe, it, expect } from 'bun:test';

import { packSections, type Section } from '#internal/v3/assemble';

const mk = (
  id: string,
  content: string,
  priority = 0,
  opts: Partial<Section> = {},
): Section => ({ id, content, priority, ...opts });

describe('packSections', () => {
  it('system 永 included，context 空时无 dropped', () => {
    const r = packSections({
      systemSections: [mk('sys1', 'You are helpful.')],
      contextSections: [],
      budgetTokens: 1000,
    });
    expect(r.systemPrompt).toContain('You are helpful.');
    expect(r.droppedSections).toEqual([]);
  });

  it('context 按 priority 升序拼入 prompt', () => {
    const r = packSections({
      systemSections: [],
      contextSections: [
        mk('b', 'BBB', 2),
        mk('a', 'AAA', 1),
        mk('c', 'CCC', 3),
      ],
      budgetTokens: 1000,
    });
    const ai = r.systemPrompt.indexOf('AAA');
    const bi = r.systemPrompt.indexOf('BBB');
    const ci = r.systemPrompt.indexOf('CCC');
    expect(ai).toBeLessThan(bi);
    expect(bi).toBeLessThan(ci);
  });

  it('超 budget 时 trimmable section 被丢', () => {
    const big = 'x'.repeat(400);
    const r = packSections({
      systemSections: [],
      contextSections: [
        mk('keep', 'small', 1, { trimmable: true }),
        mk('drop', big, 2, { trimmable: true }),
      ],
      budgetTokens: 5,
    });
    expect(r.droppedSections.find((d) => d.id === 'drop')).toBeDefined();
    expect(r.droppedSections.find((d) => d.id === 'keep')).toBeUndefined();
  });

  it('非 trimmable section 即使超 budget 也强保留', () => {
    const big = 'x'.repeat(400);
    const r = packSections({
      systemSections: [],
      contextSections: [mk('must-keep', big, 1, { trimmable: false })],
      budgetTokens: 5,
    });
    expect(r.droppedSections).toEqual([]);
    expect(r.systemPrompt).toContain(big);
  });

  it('breakdown 按 tag 累加', () => {
    const r = packSections({
      systemSections: [mk('s1', 'sys', 0, { tag: 'role' })],
      contextSections: [
        mk('c1', 'a b c d e f g h', 1, { tag: 'rag' }),
        mk('c2', 'tool docs', 2, { tag: 'tools' }),
      ],
      budgetTokens: 1000,
    });
    expect(r.breakdown.role ?? 0).toBeGreaterThan(0);
    expect(r.breakdown.rag ?? 0).toBeGreaterThan(0);
    expect(r.breakdown.tools ?? 0).toBeGreaterThan(0);
  });

  it('totalTokens = system + accepted ctx tokens', () => {
    const r = packSections({
      systemSections: [mk('s', 'placeholder', 0, { tokens: 5 })],
      contextSections: [mk('c', 'placeholder', 1, { tokens: 3 })],
      budgetTokens: 1000,
    });
    expect(r.totalTokens).toBe(8);
  });

  it('section.tokens 优先于 estimateTokens', () => {
    const r = packSections({
      systemSections: [],
      contextSections: [mk('x', 'a'.repeat(1000), 1, { tokens: 1 })],
      budgetTokens: 10,
    });
    expect(r.totalTokens).toBe(1);
    expect(r.droppedSections).toEqual([]);
  });
});
