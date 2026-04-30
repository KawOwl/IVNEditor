/**
 * 暗街 context loader（v3 实验版，从原项目移植）
 *
 * 用法：
 *   import { selectFiles, assembleContext, type State } from "./loader.mts"
 *   const state: State = { chapter: 2, phase: 3, endingTrack: "暗街深处", ... }
 *   const ctx = assembleContext(ROOT, MANIFEST, state)
 *
 * 移植改动：
 *   - require.main / __dirname CommonJS demo 块删除
 *   - fs / path 用 node: 前缀（项目惯例）
 *   - 类型导出加 readonly 修饰（与 v3 风格一致）
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

// ============== 类型定义 ==============

export type Chapter = 1 | 2 | 3;

/** 章节-结局短标识符；同名结局靠 chapter 字段消歧 */
export type EndingId =
  // ch1
  | '共犯' | '记录者' | '分道扬镳' | '白夜真结局'
  // ch2
  | '暗街深处' | '港口的夜风'
  // ch3
  | '真结局' | '好结局' | '女皇结局' | '逃亡结局' | '陨落结局';

export type FileType =
  | '引擎规则'
  | '世界观-地理'
  | '世界观-势力'
  | '角色-基础'
  | '角色-章节状态'
  | '角色-结局状态'
  | '阶段剧情'
  | '节点剧情'
  | '章节结局';

export interface FileMeta {
  readonly type: FileType;
  /** 限定章节；不写=全程 */
  readonly chapter?: Chapter[];
  /** 限定阶段/节点；第二章 0 表示准备阶段 */
  readonly phase?: number[];
  /** 限定结局走向 */
  readonly ending?: EndingId[];
  /** 限定登场角色 */
  readonly character?: string[];
  /** 限定相关势力 */
  readonly faction?: string[];
  /** 全程加载（基础设定/引擎规则） */
  readonly always?: boolean;
}

export type Manifest = Readonly<Record<string, FileMeta>>;

export interface State {
  readonly chapter: Chapter;
  /** 第一章 1-5；第二章 0=准备 / 1-5；第三章 1-4=节点 */
  readonly phase: number;
  /** 当前估算结局走向；不知道时不传 */
  readonly endingTrack?: EndingId;
  /** 当前涉及的角色（短名：卡琳娜/卡尔/康纳/罗英/艾萨克/...） */
  readonly charactersOnStage?: readonly string[];
  /** 当前涉及的势力（凯旋门/康尼家族/骷髅会/黄昏会/暗街） */
  readonly factionsRelevant?: readonly string[];
  /** 取近邻阶段：0=只当前；1=前后各 1；以此类推 */
  readonly loadAdjacentPhases?: number;
}

// ============== 核心：判定单文件是否启用 ==============

export function shouldLoad(meta: FileMeta, state: State): boolean {
  if (meta.always) return true;

  // 章节门
  if (meta.chapter && !meta.chapter.includes(state.chapter)) return false;

  // 阶段门（含近邻窗口）
  if (meta.phase) {
    const win = phaseWindow(state);
    if (!meta.phase.some((p) => win.includes(p))) return false;
  }

  // 结局门
  if (meta.ending) {
    if (!state.endingTrack || !meta.ending.includes(state.endingTrack)) {
      return false;
    }
  }

  // 角色门
  if (meta.character) {
    if (!state.charactersOnStage) return false;
    const onStage = state.charactersOnStage;
    if (!meta.character.some((c) => onStage.includes(c))) return false;
  }

  // 势力门
  if (meta.faction) {
    if (!state.factionsRelevant) return false;
    const relevant = state.factionsRelevant;
    if (!meta.faction.some((f) => relevant.includes(f))) return false;
  }

  return true;
}

function phaseWindow(state: State): number[] {
  const n = state.loadAdjacentPhases ?? 0;
  const result: number[] = [];
  for (let i = state.phase - n; i <= state.phase + n; i++) result.push(i);
  return result;
}

// ============== 选择 + 组装 ==============

export function selectFiles(manifest: Manifest, state: State): string[] {
  return Object.entries(manifest)
    .filter(([, meta]) => shouldLoad(meta, state))
    .map(([p]) => p)
    .sort();
}

/** 拼接所有命中文件，去掉 frontmatter，用 `---` 分隔 */
export function assembleContext(
  rootDir: string,
  manifest: Manifest,
  state: State,
): string {
  return selectFiles(manifest, state)
    .map((rel) => {
      const raw = fs.readFileSync(path.join(rootDir, rel), 'utf-8');
      return stripFrontmatter(raw);
    })
    .join('\n\n---\n\n');
}

export function stripFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) return content;
  const end = content.indexOf('\n---', 4);
  if (end === -1) return content;
  return content.slice(end + 4).replace(/^\n+/, '');
}

// ============== Manifest 加载 ==============

export function loadManifest(manifestPath: string): Manifest {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
}
