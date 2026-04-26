/**
 * render-transcript.mts —— 从 raw .json eval report 渲染出 LLM-friendly .md
 *
 * 用法：
 *   bun packages/core/scripts/evals/render-transcript.mts /tmp/silver-key-simulator.json
 *
 * 输出：跟 input 同名 .md（.json → .md），或者用第二个参数显式指定路径。
 *
 * 用途：旧 report 想重新出 transcript 不重跑 eval 用这个；entry script 跑完已经
 * 自动出 .md，正常情况下用不到本 CLI。
 */

import path from 'node:path';
import { renderTranscript } from '#internal/evaluation/transcript-renderer';
import type { MemoryEvaluationReport } from '#internal/evaluation/memory-harness';

const args = Bun.argv.slice(2);
const inputPath = args[0];
if (!inputPath) {
  console.error('Usage: bun render-transcript.mts <report.json> [output.md]');
  process.exit(1);
}

const outputPath = args[1] ?? defaultOutputPath(inputPath);
const raw = await Bun.file(inputPath).text();
const report = JSON.parse(raw) as MemoryEvaluationReport;

await Bun.write(outputPath, `${renderTranscript(report)}\n`);
console.log(`✓ wrote ${outputPath}`);

function defaultOutputPath(input: string): string {
  const ext = path.extname(input);
  const base = ext === '.json' ? input.slice(0, -ext.length) : input;
  return `${base}.md`;
}
