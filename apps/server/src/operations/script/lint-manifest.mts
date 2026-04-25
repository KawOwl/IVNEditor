/**
 * script.lint_manifest —— 检查剧本 manifest 与段落正文的引用一致性
 *
 * 这是 op-kit 的"第一例"，验证三件事：
 *  1. defineOp + Zod schema 形状能跑通
 *  2. HTTP / MCP 两 adapter 都能消费同一个 op 定义
 *  3. 真实业务问题被解决（trace b45a0df9 那次的 bg-unknown-scene 根因）
 *
 * 检查项（v0.1，仅覆盖最高频痛点）：
 *  - 段落正文里出现过的 background id 是否都登记在 manifest.backgrounds[]
 *  - 段落正文里出现过的 character id 是否都登记在 manifest.characters[]
 *  - 段落正文里出现过的（character, emotion）二元组，emotion 是否在
 *    manifest.characters[].sprites[] 里
 *  - 反向：manifest 登记但段落里从没引用过的"孤儿资产"（提示，不报错）
 *
 * 协议分叉：v1 和 v2 引用语法不同。v1 用工具调用形式
 * `change_scene({ background: "X", sprites: [{id: "Y", emotion: "Z"}] })`，
 * v2 用 `<background scene="X" />` / `<sprite char="Y" mood="Z" position="..." />`。
 * 这里两套都扫一遍——一个剧本不应该混用，但作者迁移过程中可能短暂共存。
 *
 * 注意：这个 op 是 read-only（auth='admin' + effect='safe'）。它不写任何
 * 东西，纯诊断。修复动作走配套的 `script.propose_manifest_alignment`
 * （后续 PR 加）。
 */

import { z } from 'zod/v4';

import type { ScriptManifest, BackgroundAsset, CharacterAsset, PromptSegment } from '@ivn/core/types';
import { CURRENT_PROTOCOL_VERSION } from '@ivn/core/protocol-version';
import { defineOp } from '#internal/operations/op-kit';
import { OpError } from '#internal/operations/errors';
import { scriptService } from '#internal/services/script-service';
import { scriptVersionService } from '#internal/services/script-version-service';

// ============================================================================
// I/O Schemas
// ============================================================================

export const lintManifestInput = z.object({
  scriptId: z.string().describe('要检查的剧本 id（见 list_scripts）'),
  versionId: z
    .string()
    .optional()
    .describe('可选：指定版本；不传则取 published，无则取最新 draft'),
});

const findingLocationSchema = z.object({
  chapterId: z.string(),
  segmentId: z.string(),
  /** content 里第一次命中的字符偏移（便于点击跳转） */
  offset: z.number().int().nonnegative(),
});

const findingSchema = z.object({
  /**
   * - 'undefined-background'  — 段落引用了 manifest 没登记的 background id
   * - 'undefined-character'   — 同上，character
   * - 'undefined-emotion'     — character 在 manifest 里登记了但缺这个 emotion
   * - 'orphan-background'     — manifest 登记了但段落从未引用（提示）
   * - 'orphan-character'      — 同上
   * - 'mixed-protocol'        — protocolVersion 是 v1 但段落里也有 <background/>
   *                             子标签（或反过来）
   */
  kind: z.enum([
    'undefined-background',
    'undefined-character',
    'undefined-emotion',
    'orphan-background',
    'orphan-character',
    'mixed-protocol',
  ]),
  /** 主语：缺失的 id / 孤儿资产名 / 协议混用的标签名 */
  detail: z.string(),
  /** 二级 detail（emotion 检查时用 character id） */
  parentId: z.string().optional(),
  /** 命中位置；orphan-* 类没有位置（manifest 侧），其它类有 */
  locations: z.array(findingLocationSchema),
  /** 严重等级。'error' = 必修；'warning' = 提示 */
  severity: z.enum(['error', 'warning']),
});

export const lintManifestOutput = z.object({
  scriptId: z.string(),
  versionId: z.string(),
  versionNumber: z.number().int(),
  versionStatus: z.enum(['draft', 'published', 'archived']),
  protocolVersion: z.enum(['v1-tool-call', 'v2-declarative-visual']),
  summary: z.object({
    errorCount: z.number().int().nonnegative(),
    warningCount: z.number().int().nonnegative(),
    backgroundsDefined: z.number().int().nonnegative(),
    backgroundsReferenced: z.number().int().nonnegative(),
    charactersDefined: z.number().int().nonnegative(),
    charactersReferenced: z.number().int().nonnegative(),
  }),
  findings: z.array(findingSchema),
});

export type LintManifestInput = z.infer<typeof lintManifestInput>;
export type LintManifestOutput = z.infer<typeof lintManifestOutput>;
type Finding = z.infer<typeof findingSchema>;

// ============================================================================
// Reference extractors —— 从段落正文里抽 ID
// ============================================================================

/**
 * v2 标签：`<background scene="X" />`
 * 容忍属性顺序、空格、单/双引号
 */
const RE_V2_BACKGROUND = /<background\b[^>]*\bscene\s*=\s*["']([a-zA-Z0-9_-]+)["']/g;

/**
 * v2 标签：`<sprite char="X" ... mood="Y" ... />`
 * mood 可能不写（"上场，使用默认 emotion" 的语义）
 */
const RE_V2_SPRITE_CHAR = /<sprite\b[^>]*\bchar\s*=\s*["']([a-zA-Z0-9_-]+)["'][^>]*>/g;
const RE_MOOD_ATTR = /\bmood\s*=\s*["']([a-zA-Z0-9_-]+)["']/;

/**
 * v1 工具调用：`change_scene({ background: "X" ...` 出现在 segment
 * 正文中（少见但有：作者写的"工具调用范例" / "fewshot"）。
 * 实际运行时 LLM 调的 tool 不进 segment.content，所以这里主要为了
 * 兼容那些把示范贴到 segment 里的剧本。
 */
const RE_V1_CHANGE_SCENE_BG = /change_scene\s*\(\s*\{[^}]*background\s*:\s*["']([a-zA-Z0-9_-]+)["']/g;
const RE_V1_CHANGE_SPRITE_CHAR = /change_sprite\s*\(\s*\{[^}]*character\s*:\s*["']([a-zA-Z0-9_-]+)["']/g;

interface ExtractedRef {
  id: string;
  /** mood / emotion，仅 sprite 引用有 */
  mood?: string;
  parentId?: string;
  offset: number;
}

interface ExtractResult {
  backgrounds: ExtractedRef[];
  characters: ExtractedRef[];
  /** (charId, mood) 二元组 */
  emotions: ExtractedRef[];
  /** v1 / v2 混用检测：在同一段里同时出现两套语法 */
  mixedProtocolHits: { tag: string; offset: number }[];
}

function extractFromSegment(content: string, protocolVersion: 'v1-tool-call' | 'v2-declarative-visual'): ExtractResult {
  const result: ExtractResult = {
    backgrounds: [],
    characters: [],
    emotions: [],
    mixedProtocolHits: [],
  };

  // v2 background
  for (const m of content.matchAll(RE_V2_BACKGROUND)) {
    result.backgrounds.push({ id: m[1]!, offset: m.index! });
    if (protocolVersion === 'v1-tool-call') {
      result.mixedProtocolHits.push({ tag: '<background>', offset: m.index! });
    }
  }
  // v2 sprite + mood
  for (const m of content.matchAll(RE_V2_SPRITE_CHAR)) {
    const charId = m[1]!;
    const wholeTag = m[0]!;
    const moodMatch = wholeTag.match(RE_MOOD_ATTR);
    result.characters.push({ id: charId, offset: m.index! });
    if (moodMatch) {
      result.emotions.push({ id: moodMatch[1]!, parentId: charId, offset: m.index! });
    }
    if (protocolVersion === 'v1-tool-call') {
      result.mixedProtocolHits.push({ tag: '<sprite>', offset: m.index! });
    }
  }
  // v1 change_scene
  for (const m of content.matchAll(RE_V1_CHANGE_SCENE_BG)) {
    result.backgrounds.push({ id: m[1]!, offset: m.index! });
    if (protocolVersion === 'v2-declarative-visual') {
      result.mixedProtocolHits.push({ tag: 'change_scene', offset: m.index! });
    }
  }
  // v1 change_sprite
  for (const m of content.matchAll(RE_V1_CHANGE_SPRITE_CHAR)) {
    result.characters.push({ id: m[1]!, offset: m.index! });
    if (protocolVersion === 'v2-declarative-visual') {
      result.mixedProtocolHits.push({ tag: 'change_sprite', offset: m.index! });
    }
  }
  return result;
}

// ============================================================================
// Lint logic
// ============================================================================

interface FindingAccumulator {
  refs: Map<string, Array<{ chapterId: string; segmentId: string; offset: number }>>;
}

function accumRef(
  acc: FindingAccumulator,
  id: string,
  loc: { chapterId: string; segmentId: string; offset: number },
): void {
  const list = acc.refs.get(id);
  if (list) list.push(loc);
  else acc.refs.set(id, [loc]);
}

function lintManifest(manifest: ScriptManifest): {
  findings: Finding[];
  backgroundsReferenced: Set<string>;
  charactersReferenced: Set<string>;
} {
  const protocolVersion = manifest.protocolVersion ?? CURRENT_PROTOCOL_VERSION;
  const definedBackgrounds = new Set<string>(
    (manifest.backgrounds ?? []).map((b: BackgroundAsset) => b.id),
  );
  const definedCharacters = new Map<string, Set<string>>(
    (manifest.characters ?? []).map((c: CharacterAsset) => [
      c.id,
      new Set(c.sprites.map((s) => s.id)),
    ]),
  );

  const bgAcc: FindingAccumulator = { refs: new Map() };
  const charAcc: FindingAccumulator = { refs: new Map() };
  // emotions 的 key 用 `${char}.${mood}` 拼接
  const emoAcc: FindingAccumulator = { refs: new Map() };
  const emoMeta = new Map<string, { charId: string; mood: string }>();
  const mixedAcc: FindingAccumulator = { refs: new Map() };

  for (const chapter of manifest.chapters) {
    for (const segment of chapter.segments) {
      const seg = segment as PromptSegment;
      const ext = extractFromSegment(seg.content, protocolVersion);

      for (const ref of ext.backgrounds) {
        accumRef(bgAcc, ref.id, { chapterId: chapter.id, segmentId: seg.id, offset: ref.offset });
      }
      for (const ref of ext.characters) {
        accumRef(charAcc, ref.id, { chapterId: chapter.id, segmentId: seg.id, offset: ref.offset });
      }
      for (const ref of ext.emotions) {
        const key = `${ref.parentId}.${ref.id}`;
        emoMeta.set(key, { charId: ref.parentId!, mood: ref.id });
        accumRef(emoAcc, key, {
          chapterId: chapter.id,
          segmentId: seg.id,
          offset: ref.offset,
        });
      }
      for (const hit of ext.mixedProtocolHits) {
        accumRef(mixedAcc, hit.tag, {
          chapterId: chapter.id,
          segmentId: seg.id,
          offset: hit.offset,
        });
      }
    }
  }

  const findings: Finding[] = [];

  // undefined-background
  for (const [id, locs] of bgAcc.refs) {
    if (!definedBackgrounds.has(id)) {
      findings.push({ kind: 'undefined-background', detail: id, locations: locs, severity: 'error' });
    }
  }
  // undefined-character
  for (const [id, locs] of charAcc.refs) {
    if (!definedCharacters.has(id)) {
      findings.push({ kind: 'undefined-character', detail: id, locations: locs, severity: 'error' });
    }
  }
  // undefined-emotion（character 存在但 emotion 没登记）
  for (const [key, locs] of emoAcc.refs) {
    const meta = emoMeta.get(key)!;
    const sprites = definedCharacters.get(meta.charId);
    if (!sprites) continue; // character 本身不存在已经在 undefined-character 报过了
    if (!sprites.has(meta.mood)) {
      findings.push({
        kind: 'undefined-emotion',
        detail: meta.mood,
        parentId: meta.charId,
        locations: locs,
        severity: 'error',
      });
    }
  }
  // orphan-background（manifest 登记但从没引用）
  for (const id of definedBackgrounds) {
    if (!bgAcc.refs.has(id)) {
      findings.push({
        kind: 'orphan-background',
        detail: id,
        locations: [],
        severity: 'warning',
      });
    }
  }
  // orphan-character
  for (const [id] of definedCharacters) {
    if (!charAcc.refs.has(id)) {
      findings.push({
        kind: 'orphan-character',
        detail: id,
        locations: [],
        severity: 'warning',
      });
    }
  }
  // mixed-protocol
  for (const [tag, locs] of mixedAcc.refs) {
    findings.push({
      kind: 'mixed-protocol',
      detail: tag,
      locations: locs,
      severity: 'warning',
    });
  }

  return {
    findings,
    backgroundsReferenced: new Set(bgAcc.refs.keys()),
    charactersReferenced: new Set(charAcc.refs.keys()),
  };
}

// ============================================================================
// Op definition
// ============================================================================

export const lintManifestOp = defineOp({
  name: 'script.lint_manifest',
  description:
    '检查剧本 manifest 与段落正文的引用一致性：扫所有段落，对照 backgrounds[] / characters[] 白名单，' +
    '报告未登记的 background / character / emotion id（segments 里出现但 manifest 缺登记），' +
    '以及孤儿资产（登记但段落从未引用）和 v1/v2 协议混用的标签。' +
    '只读 op，不改剧本。这是修复 trace 类 bg-unknown-scene degrade 的诊断入口。',
  category: 'script',
  effect: 'safe',
  auth: 'admin',
  uiLabel: 'Lint 剧本 manifest',
  input: lintManifestInput,
  output: lintManifestOutput,
  async exec(input, _ctx) {
    const { scriptId, versionId } = input;

    const script = await scriptService.getById(scriptId);
    if (!script) {
      throw new OpError('NOT_FOUND', `Script not found: ${scriptId}`);
    }

    // 解析目标版本
    let version;
    if (versionId) {
      version = await scriptVersionService.getById(versionId);
      if (!version || version.scriptId !== scriptId) {
        throw new OpError('NOT_FOUND', `Version ${versionId} not found for script ${scriptId}`);
      }
    } else {
      version = await scriptVersionService.getCurrentPublished(scriptId);
      if (!version) {
        const all = await scriptVersionService.listByScript(scriptId);
        if (all.length === 0) {
          throw new OpError('NOT_FOUND', `No versions exist for script ${scriptId}`);
        }
        version = await scriptVersionService.getById(all[0]!.id);
        if (!version) {
          throw new OpError('NOT_FOUND', `Latest version vanished mid-query for script ${scriptId}`);
        }
      }
    }

    const protocolVersion = version.manifest.protocolVersion ?? CURRENT_PROTOCOL_VERSION;
    const { findings, backgroundsReferenced, charactersReferenced } = lintManifest(version.manifest);

    const errorCount = findings.filter((f) => f.severity === 'error').length;
    const warningCount = findings.filter((f) => f.severity === 'warning').length;

    return {
      scriptId,
      versionId: version.id,
      versionNumber: version.versionNumber,
      versionStatus: version.status,
      protocolVersion,
      summary: {
        errorCount,
        warningCount,
        backgroundsDefined: (version.manifest.backgrounds ?? []).length,
        backgroundsReferenced: backgroundsReferenced.size,
        charactersDefined: (version.manifest.characters ?? []).length,
        charactersReferenced: charactersReferenced.size,
      },
      findings,
    };
  },
});

// 导出"纯函数"版本，方便单测不走 service 直接验逻辑
export const _internal = { extractFromSegment, lintManifest };
