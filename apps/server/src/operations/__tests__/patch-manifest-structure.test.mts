/**
 * patch-manifest-structure 单元测试 —— 纯 patch 逻辑，不走 service。
 *
 * 重点：验证 chapters / segments 在任何 patch 路径下都原样保留。
 */

import { describe, it, expect } from 'bun:test';

import { _internal } from '#internal/operations/script/patch-manifest-structure';
import { OpError } from '#internal/operations/errors';
import type { ScriptManifest } from '@ivn/core/types';

const { applyStructuralPatch } = _internal;

function makeBaselineManifest(): ScriptManifest {
  return {
    id: 's1',
    label: 'baseline',
    protocolVersion: 'v2-declarative-visual',
    chapters: [
      {
        id: 'ch1',
        label: 'C1',
        flowGraph: { id: 'fg1', label: 'F', nodes: [], edges: [] },
        segments: [
          {
            id: 'seg1',
            label: 'L',
            content: 'BASELINE-CONTENT-DO-NOT-TOUCH',
            contentHash: 'h1',
            type: 'content',
            sourceDoc: 'doc',
            role: 'system',
            priority: 0,
            tokenCount: 12,
          },
          {
            id: 'seg2',
            label: 'L2',
            content: 'ANOTHER-CONTENT',
            contentHash: 'h2',
            type: 'content',
            sourceDoc: 'doc',
            role: 'system',
            priority: 1,
            tokenCount: 5,
          },
        ],
      },
    ],
    stateSchema: {
      variables: [{ name: 'baseline_var', type: 'number', initial: 0, description: '' }],
    },
    memoryConfig: { contextBudget: 100, compressionThreshold: 90, recencyWindow: 5 },
    enabledTools: [],
    backgrounds: [{ id: 'bg_old', assetUrl: '/old.png' }],
    characters: [{ id: 'char_old', displayName: '旧', sprites: [] }],
    promptAssemblyOrder: ['old_section'],
  };
}

describe('applyStructuralPatch · 单字段替换', () => {
  it('characters 整体替换', () => {
    const m = makeBaselineManifest();
    const newCharacters = [
      { id: 'alice', displayName: '爱丽丝', sprites: [] },
      { id: 'bob', displayName: '鲍勃', sprites: [] },
    ];
    const { patchedFields } = applyStructuralPatch(m, { characters: newCharacters });
    expect(patchedFields).toEqual(['characters']);
    expect(m.characters).toEqual(newCharacters);
  });

  it('backgrounds 整体替换', () => {
    const m = makeBaselineManifest();
    const newBgs = [{ id: 'cafe', assetUrl: '/c.png', label: '咖啡馆' }];
    const { patchedFields } = applyStructuralPatch(m, { backgrounds: newBgs });
    expect(patchedFields).toEqual(['backgrounds']);
    expect(m.backgrounds).toEqual(newBgs);
  });

  it('stateSchema 整体替换', () => {
    const m = makeBaselineManifest();
    const newSchema = {
      variables: [
        { name: 'hp', type: 'number' as const, initial: 100, description: 'HP' },
      ],
    };
    const { patchedFields } = applyStructuralPatch(m, { stateSchema: newSchema });
    expect(patchedFields).toEqual(['stateSchema']);
    expect(m.stateSchema).toEqual(newSchema);
  });

  it('memoryConfig 整体替换', () => {
    const m = makeBaselineManifest();
    const newCfg = { contextBudget: 200, compressionThreshold: 180, recencyWindow: 10 };
    const { patchedFields } = applyStructuralPatch(m, { memoryConfig: newCfg });
    expect(patchedFields).toEqual(['memoryConfig']);
    expect(m.memoryConfig).toEqual(newCfg);
  });

  it('promptAssemblyOrder 整体替换', () => {
    const m = makeBaselineManifest();
    const newOrder = ['rules', 'state', 'history'];
    const { patchedFields } = applyStructuralPatch(m, { promptAssemblyOrder: newOrder });
    expect(patchedFields).toEqual(['promptAssemblyOrder']);
    expect(m.promptAssemblyOrder).toEqual(newOrder);
  });

  it('空数组合法（清空 characters / backgrounds / promptAssemblyOrder）', () => {
    const m = makeBaselineManifest();
    applyStructuralPatch(m, {
      characters: [],
      backgrounds: [],
      promptAssemblyOrder: [],
    });
    expect(m.characters).toEqual([]);
    expect(m.backgrounds).toEqual([]);
    expect(m.promptAssemblyOrder).toEqual([]);
  });
});

describe('applyStructuralPatch · 多字段一起替换', () => {
  it('一次替换 characters + backgrounds + stateSchema', () => {
    const m = makeBaselineManifest();
    const { patchedFields } = applyStructuralPatch(m, {
      characters: [{ id: 'a', displayName: 'A', sprites: [] }],
      backgrounds: [{ id: 'b', assetUrl: '/b.png' }],
      stateSchema: { variables: [] },
    });
    expect(patchedFields.sort()).toEqual(['backgrounds', 'characters', 'stateSchema']);
    expect(m.characters).toHaveLength(1);
    expect(m.backgrounds).toHaveLength(1);
    expect(m.stateSchema.variables).toHaveLength(0);
  });
});

describe('applyStructuralPatch · 关键 invariant：chapters / segments 不动', () => {
  it('单字段 patch 不影响 chapters / segments', () => {
    const m = makeBaselineManifest();
    const beforeChapters = JSON.stringify(m.chapters);
    applyStructuralPatch(m, {
      characters: [{ id: 'new', displayName: '新', sprites: [] }],
    });
    expect(JSON.stringify(m.chapters)).toBe(beforeChapters);
  });

  it('多字段 patch 也不影响 chapters / segments', () => {
    const m = makeBaselineManifest();
    const beforeChapters = JSON.stringify(m.chapters);
    applyStructuralPatch(m, {
      characters: [],
      backgrounds: [{ id: 'x', assetUrl: '/x.png' }],
      stateSchema: { variables: [{ name: 'k', type: 'string', initial: '', description: '' }] },
      memoryConfig: { contextBudget: 1, compressionThreshold: 1, recencyWindow: 1 },
      promptAssemblyOrder: ['x'],
    });
    expect(JSON.stringify(m.chapters)).toBe(beforeChapters);
  });

  it('segment.content 在任何 patch 路径下都不被改写', () => {
    const m = makeBaselineManifest();
    applyStructuralPatch(m, {
      characters: [],
      backgrounds: [],
      stateSchema: { variables: [] },
      memoryConfig: { contextBudget: 99, compressionThreshold: 80, recencyWindow: 3 },
      promptAssemblyOrder: ['a', 'b'],
    });
    expect(m.chapters[0]!.segments[0]!.content).toBe('BASELINE-CONTENT-DO-NOT-TOUCH');
    expect(m.chapters[0]!.segments[1]!.content).toBe('ANOTHER-CONTENT');
    expect(m.chapters[0]!.segments[0]!.contentHash).toBe('h1');
    expect(m.chapters[0]!.segments[1]!.contentHash).toBe('h2');
  });
});

describe('applyStructuralPatch · 未传字段保留基线', () => {
  it('只传 characters，其他字段全保持基线值', () => {
    const m = makeBaselineManifest();
    const baseline = makeBaselineManifest();
    applyStructuralPatch(m, { characters: [] });
    expect(m.backgrounds).toEqual(baseline.backgrounds);
    expect(m.stateSchema).toEqual(baseline.stateSchema);
    expect(m.memoryConfig).toEqual(baseline.memoryConfig);
    expect(m.promptAssemblyOrder).toEqual(baseline.promptAssemblyOrder);
  });

  it('全空 patch 不动 manifest 任何字段，patchedFields 为空', () => {
    const m = makeBaselineManifest();
    const baseline = makeBaselineManifest();
    const { patchedFields } = applyStructuralPatch(m, {});
    expect(patchedFields).toEqual([]);
    expect(m).toEqual(baseline);
  });
});

describe('applyStructuralPatch · 形状校验', () => {
  it('characters 不是数组 → INVALID_INPUT', () => {
    const m = makeBaselineManifest();
    expect(() => applyStructuralPatch(m, { characters: { id: 'wrong' } })).toThrow(OpError);
  });

  it('backgrounds 不是数组 → INVALID_INPUT', () => {
    const m = makeBaselineManifest();
    expect(() => applyStructuralPatch(m, { backgrounds: 'no' })).toThrow(OpError);
  });

  it('stateSchema 不是 object → INVALID_INPUT', () => {
    const m = makeBaselineManifest();
    expect(() => applyStructuralPatch(m, { stateSchema: 'no' })).toThrow(OpError);
  });

  it('stateSchema.variables 不是数组 → INVALID_INPUT', () => {
    const m = makeBaselineManifest();
    expect(() => applyStructuralPatch(m, { stateSchema: { variables: 'no' } })).toThrow(OpError);
  });

  it('memoryConfig 不是 object → INVALID_INPUT', () => {
    const m = makeBaselineManifest();
    expect(() => applyStructuralPatch(m, { memoryConfig: 42 })).toThrow(OpError);
  });

  it('promptAssemblyOrder 不是数组 → INVALID_INPUT', () => {
    const m = makeBaselineManifest();
    expect(() => applyStructuralPatch(m, { promptAssemblyOrder: 'rules,state' })).toThrow(OpError);
  });

  it('null characters 视作"不传"（z.unknown().optional() 已经处理过 undefined，null 单独走非数组分支）', () => {
    const m = makeBaselineManifest();
    expect(() => applyStructuralPatch(m, { characters: null })).toThrow(OpError);
  });
});

describe('applyStructuralPatch · 沿用最少校验', () => {
  it('characters 数组里的元素不做深 zod（允许 schema 演进 / 未来字段）', () => {
    const m = makeBaselineManifest();
    const weird = [{ id: 'x', displayName: 'X', sprites: [], futureField: 'ok' }];
    applyStructuralPatch(m, { characters: weird });
    expect(m.characters).toEqual(weird as ScriptManifest['characters']);
  });

  it('memoryConfig 缺字段（不深校验）也通过', () => {
    const m = makeBaselineManifest();
    applyStructuralPatch(m, { memoryConfig: { onlyKey: 1 } });
    expect((m.memoryConfig as unknown as { onlyKey: number }).onlyKey).toBe(1);
  });
});
