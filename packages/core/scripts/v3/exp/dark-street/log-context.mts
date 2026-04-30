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

const basename = (p: string): string => {
  const idx = p.lastIndexOf('/');
  const name = idx >= 0 ? p.slice(idx + 1) : p;
  return name.replace(/\.md$/, '');
};

const fmtSize = (chars: number, tokens: number): string =>
  `${(chars / 1000).toFixed(1)}K chars / ~${(tokens / 1000).toFixed(1)}K tok`;

export const formatTurnLog = (
  turn: number,
  curr: ContextSnapshot,
  prev: ContextSnapshot | null,
): string => {
  const sizeStr = fmtSize(curr.chars, curr.tokens);
  if (prev === null) {
    return `[turn ${turn}] ctx: ${curr.files.length} files, ${sizeStr}`;
  }
  const prevSet = new Set(prev.files);
  const currSet = new Set(curr.files);
  const added = curr.files.filter((f) => !prevSet.has(f));
  const removed = prev.files.filter((f) => !currSet.has(f));
  if (added.length === 0 && removed.length === 0) {
    return `[turn ${turn}] ctx: ${curr.files.length} files, ${sizeStr} (unchanged)`;
  }
  const parts: string[] = [];
  if (added.length > 0) {
    parts.push(`+${added.length} [${added.map(basename).join(', ')}]`);
  }
  if (removed.length > 0) {
    parts.push(`-${removed.length} [${removed.map(basename).join(', ')}]`);
  }
  return `[turn ${turn}] ctx: ${curr.files.length} files, ${sizeStr} ${parts.join(' ')}`;
};
