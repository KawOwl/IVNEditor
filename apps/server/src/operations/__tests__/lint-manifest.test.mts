/**
 * lint-manifest 单元测试 —— 纯 lint 逻辑，不走 service。
 *
 * 服务层调用（exec 拉 script + version）由 mcp-route 集成测试覆盖。
 */

import { describe, it, expect } from 'bun:test';

import { _internal } from '#internal/operations/script/lint-manifest';
import type { ScriptManifest } from '@ivn/core/types';

const { extractFromSegment, lintManifest } = _internal;

// ============================================================================
// extractFromSegment
// ============================================================================

describe('extractFromSegment · v2 protocol', () => {
  it('抽 v2 <background scene="X" />', () => {
    const ext = extractFromSegment('<background scene="cafe_interior" />', 'v2-declarative-visual');
    expect(ext.backgrounds).toHaveLength(1);
    expect(ext.backgrounds[0]!.id).toBe('cafe_interior');
  });

  it('抽 v2 <sprite char="X" mood="Y" />', () => {
    const ext = extractFromSegment(
      '<sprite char="sakuya" mood="smile" position="center" />',
      'v2-declarative-visual',
    );
    expect(ext.characters[0]!.id).toBe('sakuya');
    expect(ext.emotions[0]!.id).toBe('smile');
    expect(ext.emotions[0]!.parentId).toBe('sakuya');
  });

  it('多个标签连写都抽到', () => {
    const c = `<narration>
      <background scene="bg_a" />
      <sprite char="sakuya" mood="smile" />
      <sprite char="karina" mood="frown" />
    </narration>`;
    const ext = extractFromSegment(c, 'v2-declarative-visual');
    expect(ext.backgrounds).toHaveLength(1);
    expect(ext.characters).toHaveLength(2);
    expect(ext.emotions).toHaveLength(2);
  });

  it('单引号 + 属性顺序乱也能抽', () => {
    const ext = extractFromSegment(
      `<sprite mood='angry' char='ghost' />`,
      'v2-declarative-visual',
    );
    expect(ext.characters[0]!.id).toBe('ghost');
    expect(ext.emotions[0]!.id).toBe('angry');
  });

  it('v2 协议下出现 change_scene → 标记 mixed-protocol', () => {
    const ext = extractFromSegment(
      `change_scene({ background: "city_street" })`,
      'v2-declarative-visual',
    );
    expect(ext.mixedProtocolHits).toHaveLength(1);
    expect(ext.mixedProtocolHits[0]!.tag).toBe('change_scene');
  });
});

describe('extractFromSegment · v1 protocol', () => {
  it('抽 v1 change_scene({ background: "X" })', () => {
    const ext = extractFromSegment(
      'change_scene({ background: "library_day" })',
      'v1-tool-call',
    );
    expect(ext.backgrounds[0]!.id).toBe('library_day');
  });

  it('抽 v1 change_sprite({ character: "X" })', () => {
    const ext = extractFromSegment(
      'change_sprite({ character: "sakuya", emotion: "smile" })',
      'v1-tool-call',
    );
    expect(ext.characters[0]!.id).toBe('sakuya');
  });

  it('v1 协议下出现 <background/> → 标记 mixed-protocol', () => {
    const ext = extractFromSegment(
      `<background scene="x" />`,
      'v1-tool-call',
    );
    expect(ext.mixedProtocolHits).toHaveLength(1);
    expect(ext.mixedProtocolHits[0]!.tag).toBe('<background>');
  });
});

// ============================================================================
// lintManifest
// ============================================================================

function makeManifest(opts: {
  protocolVersion: 'v1-tool-call' | 'v2-declarative-visual';
  segmentContent: string;
  backgrounds?: { id: string; assetUrl: string }[];
  characters?: { id: string; sprites: { id: string; assetUrl: string }[] }[];
}): ScriptManifest {
  return {
    id: 's1',
    label: 'test',
    protocolVersion: opts.protocolVersion,
    chapters: [
      {
        id: 'ch1',
        label: 'C1',
        flowGraph: { id: 'fg1', label: 'F', nodes: [], edges: [] },
        segments: [
          {
            id: 'seg1',
            label: 'L',
            content: opts.segmentContent,
            contentHash: 'h',
            type: 'content',
            sourceDoc: 'doc',
            role: 'system',
            priority: 0,
            tokenCount: 0,
          },
        ],
      },
    ],
    stateSchema: { variables: [] },
    memoryConfig: { contextBudget: 100, compressionThreshold: 90, recencyWindow: 5 },
    enabledTools: [],
    backgrounds: (opts.backgrounds ?? []) as ScriptManifest['backgrounds'],
    characters: (opts.characters ?? []) as ScriptManifest['characters'],
  };
}

describe('lintManifest', () => {
  it('段落引用未登记的 background → undefined-background error', () => {
    const m = makeManifest({
      protocolVersion: 'v2-declarative-visual',
      segmentContent: '<background scene="city_street_morning" />',
      backgrounds: [],
    });
    const r = lintManifest(m);
    const err = r.findings.find((f) => f.kind === 'undefined-background');
    expect(err).toBeDefined();
    expect(err?.detail).toBe('city_street_morning');
    expect(err?.severity).toBe('error');
    expect(err?.locations[0]).toMatchObject({ chapterId: 'ch1', segmentId: 'seg1' });
  });

  it('段落引用未登记的 character → undefined-character error', () => {
    const m = makeManifest({
      protocolVersion: 'v2-declarative-visual',
      segmentContent: '<sprite char="ghost" mood="angry" />',
      characters: [],
    });
    const r = lintManifest(m);
    const err = r.findings.find((f) => f.kind === 'undefined-character');
    expect(err?.detail).toBe('ghost');
  });

  it('character 存在但 emotion 没登记 → undefined-emotion', () => {
    const m = makeManifest({
      protocolVersion: 'v2-declarative-visual',
      segmentContent: '<sprite char="sakuya" mood="laughing" />',
      characters: [{ id: 'sakuya', sprites: [{ id: 'smile', assetUrl: '/x.png' }] }],
    });
    const r = lintManifest(m);
    const err = r.findings.find((f) => f.kind === 'undefined-emotion');
    expect(err?.detail).toBe('laughing');
    expect(err?.parentId).toBe('sakuya');
  });

  it('登记但段落未引用的资产 → orphan warning', () => {
    const m = makeManifest({
      protocolVersion: 'v2-declarative-visual',
      segmentContent: '<background scene="used" />',
      backgrounds: [
        { id: 'used', assetUrl: '/u.png' },
        { id: 'orphan', assetUrl: '/o.png' },
      ],
    });
    const r = lintManifest(m);
    const orph = r.findings.find((f) => f.kind === 'orphan-background');
    expect(orph?.detail).toBe('orphan');
    expect(orph?.severity).toBe('warning');
  });

  it('全部对齐时无 finding（除可能的 orphan）', () => {
    const m = makeManifest({
      protocolVersion: 'v2-declarative-visual',
      segmentContent: '<background scene="cafe" /><sprite char="sakuya" mood="smile" />',
      backgrounds: [{ id: 'cafe', assetUrl: '/c.png' }],
      characters: [{ id: 'sakuya', sprites: [{ id: 'smile', assetUrl: '/s.png' }] }],
    });
    const r = lintManifest(m);
    expect(r.findings.filter((f) => f.severity === 'error')).toHaveLength(0);
  });

  it('counts referenced ids correctly', () => {
    const m = makeManifest({
      protocolVersion: 'v2-declarative-visual',
      segmentContent: `<background scene="a" /><background scene="a" /><background scene="b" />`,
      backgrounds: [
        { id: 'a', assetUrl: '/a.png' },
        { id: 'b', assetUrl: '/b.png' },
      ],
    });
    const r = lintManifest(m);
    expect(r.backgroundsReferenced.size).toBe(2); // dedup
  });

  it('再现 trace b45a0df9 的根因情形', () => {
    // 复刻：剧本是 v2，但 manifest.backgrounds 是空的，正文里写了
    // <background scene="city_street_morning" />。
    const m = makeManifest({
      protocolVersion: 'v2-declarative-visual',
      segmentContent: `<narration>
        <background scene="city_street_morning" />
        故事开篇...
      </narration>`,
      backgrounds: [],
      characters: [
        { id: 'xia_ying', sprites: [] },
        { id: 'noah', sprites: [] },
      ],
    });
    const r = lintManifest(m);
    const err = r.findings.find(
      (f) => f.kind === 'undefined-background' && f.detail === 'city_street_morning',
    );
    expect(err).toBeDefined();
    expect(err?.severity).toBe('error');
    // orphan 警告也应该挂在 xia_ying / noah 上（段落没引用任何 character）
    const orphans = r.findings.filter((f) => f.kind === 'orphan-character');
    expect(orphans.map((f) => f.detail).sort()).toEqual(['noah', 'xia_ying']);
  });
});
