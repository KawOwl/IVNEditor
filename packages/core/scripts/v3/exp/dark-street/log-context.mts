// 上下文 snapshot 工具。每 turn 拼装一遍 context，捎带 digest（file 列表 +
// 大小 + token 估算）+ diff（vs 上 turn 的新增 / 移除文件）。供 entry 脚本
// 在 stderr 一行 dim 显示，玩家观察 state-driven 路由变化。

import * as fs from 'node:fs';
import * as path from 'node:path';

import { estimateTokens } from '#internal/v3/tokens';
import {
  selectFiles,
  stripFrontmatter,
  type Manifest,
  type State,
} from './loader.mts';

export type ContextSnapshot = {
  readonly files: readonly string[];
  readonly content: string;
  readonly chars: number;
  readonly tokens: number;
};

export const buildSnapshot = (
  rootDir: string,
  manifest: Manifest,
  state: State,
): ContextSnapshot => {
  const files = selectFiles(manifest, state);
  const content = files
    .map((rel) =>
      stripFrontmatter(fs.readFileSync(path.join(rootDir, rel), 'utf-8')),
    )
    .join('\n\n---\n\n');
  return {
    files,
    content,
    chars: content.length,
    tokens: estimateTokens(content),
  };
};

const fmtSize = (chars: number, tokens: number): string =>
  `${(chars / 1000).toFixed(1)}K chars / ~${(tokens / 1000).toFixed(1)}K tok`;

// 完整列表 + 增/删标记。多行输出，caller 直接 stderr 写。
//   [turn N] ctx: 47 files, 43K chars / ~32K tok (+3 -1 vs prev)
//     00_引擎/00-0_引擎规则_引言.md
//     00_引擎/00-1_执行铁律.md
//   + 02_角色/12-1_角色_卡尔_基础设定.md
//     02_角色/10-1_角色_主角_预设帕兹.md
//     ...
//   - removed: 03_第一章/21-1_第一章结局_共犯.md
export const formatTurnLog = (
  turn: number,
  curr: ContextSnapshot,
  prev: ContextSnapshot | null,
): string => {
  const sizeStr = fmtSize(curr.chars, curr.tokens);
  const lines: string[] = [];

  if (prev === null) {
    lines.push(`[turn ${turn}] ctx: ${curr.files.length} files, ${sizeStr}`);
    for (const f of curr.files) lines.push(`    ${f}`);
    return lines.join('\n');
  }

  const prevSet = new Set(prev.files);
  const currSet = new Set(curr.files);
  const added = curr.files.filter((f) => !prevSet.has(f));
  const removed = prev.files.filter((f) => !currSet.has(f));

  const diffStr =
    added.length === 0 && removed.length === 0
      ? '(unchanged)'
      : `(+${added.length} -${removed.length} vs prev)`;
  lines.push(
    `[turn ${turn}] ctx: ${curr.files.length} files, ${sizeStr} ${diffStr}`,
  );

  for (const f of curr.files) {
    lines.push(prevSet.has(f) ? `    ${f}` : `  + ${f}`);
  }
  for (const f of removed) {
    lines.push(`  - ${f} (removed)`);
  }

  return lines.join('\n');
};
