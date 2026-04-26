/**
 * Transcript renderer —— 把 MemoryEvaluationReport 转成 LLM-friendly markdown
 *
 * 用法两条路：
 *   - entry script 跑完直接 render 一份 .md 落地（人 + LLM judge 都能直接读）
 *   - 老 .json report 拉过来 reprocess（scripts/evals/render-transcript.mts CLI）
 *
 * 不在 transcript 里塞：raw LLM call、memory snapshot 内部状态、coreEvent 流
 * —— 那些是 .json 调试用，judge 不该依赖。本 view 只放"玩家视角能看到的东西"
 * + 必要的 variant metadata（哪个 memory provider、跑了几 turn）。
 */

import type { Sentence } from '#internal/types';
import type {
  MemoryEvaluationReport,
  MemoryEvaluationRun,
} from '#internal/evaluation/memory-harness';

export function renderTranscript(report: MemoryEvaluationReport): string {
  const sections = report.runs.map(renderVariant);
  const header = `# Memory eval transcript: ${report.scenarioId}\n\nVariants: ${report.runs.map((r) => r.variantId).join(', ')}\n`;
  return [header, ...sections].join('\n\n---\n\n');
}

function renderVariant(run: MemoryEvaluationRun): string {
  return [
    renderVariantHeader(run),
    '',
    renderTurns(run.recording.sentences),
    '',
    renderVariantFooter(run),
  ].join('\n');
}

function renderVariantHeader(run: MemoryEvaluationRun): string {
  const generateCalls = run.llmCalls.filter((c) => c.kind === 'generate').length;
  const compressCalls = run.llmCalls.filter((c) => c.kind === 'compress').length;
  // 注意：state vars / scene 的"final"快照统一在 footer 里展示（renderVariantFooter）。
  // header 只放 run-level metadata，避免重复。
  return [
    `## Variant: \`${run.variantId}\``,
    `- **Memory provider**: ${run.memoryKind}`,
    `- **Turns run**: ${run.turnsRun}`,
    `- **Stop reason**: ${run.stopReason}`,
    `- **LLM calls**: ${run.llmCalls.length} (${generateCalls} generate, ${compressCalls} compress)`,
  ].join('\n');
}

function renderVariantFooter(run: MemoryEvaluationRun): string {
  const finalScene = run.currentScene;
  const sceneDesc = `bg=${finalScene.background ?? '(none)'}, sprites=[${finalScene.sprites.map((s) => s.id).join(', ')}]`;
  return [
    '### Final state',
    `- Scene: ${sceneDesc}`,
    `- State vars: ${formatStateVars(run.stateVars)}`,
  ].join('\n');
}

function renderTurns(sentences: ReadonlyArray<Sentence>): string {
  if (sentences.length === 0) return '_(no sentences recorded)_';

  const byTurn = groupByTurn(sentences);
  const turnNumbers = Array.from(byTurn.keys()).sort((a, b) => a - b);
  return turnNumbers
    .map((turn) => renderTurn(turn, byTurn.get(turn) ?? []))
    .join('\n\n');
}

function groupByTurn(sentences: ReadonlyArray<Sentence>): Map<number, Sentence[]> {
  const map = new Map<number, Sentence[]>();
  for (const sentence of sentences) {
    const arr = map.get(sentence.turnNumber);
    if (arr) arr.push(sentence);
    else map.set(sentence.turnNumber, [sentence]);
  }
  return map;
}

function renderTurn(turn: number, sentences: Sentence[]): string {
  const sorted = [...sentences].sort((a, b) => a.index - b.index);
  return [`### Turn ${turn}`, ...sorted.map(renderSentence)].join('\n');
}

function renderSentence(sentence: Sentence): string {
  switch (sentence.kind) {
    case 'narration':
      return `${sentence.text}${sentence.truncated ? ' _…(truncated)_' : ''}`;
    case 'dialogue':
      return `**${sentence.pf.speaker}**: ${sentence.text}${sentence.truncated ? ' _…(truncated)_' : ''}`;
    case 'scene_change':
      return renderSceneChange(sentence);
    case 'signal_input':
      return renderSignalInput(sentence);
    case 'player_input':
      return renderPlayerInput(sentence);
  }
}

function renderSceneChange(sentence: Extract<Sentence, { kind: 'scene_change' }>): string {
  const bg = sentence.scene.background ?? '(none)';
  const sprites = sentence.scene.sprites
    .map((sp) => `${sp.id}:${sp.emotion}@${sp.position}`)
    .join(', ');
  const transitionPart = sentence.transition ? `, transition=${sentence.transition}` : '';
  return `_[scene] bg=${bg}, sprites=[${sprites || '—'}]${transitionPart}_`;
}

function renderSignalInput(sentence: Extract<Sentence, { kind: 'signal_input' }>): string {
  const choicesBlock = sentence.choices.length > 0
    ? sentence.choices.map((c, i) => `${i + 1}. ${c}`).join('\n  ')
    : '_(freetext)_';
  return `> **[GM signals]** ${sentence.hint}\n>\n> Choices:\n>   ${choicesBlock}`;
}

function renderPlayerInput(sentence: Extract<Sentence, { kind: 'player_input' }>): string {
  const indicator = sentence.selectedIndex !== undefined
    ? ` _(selected #${sentence.selectedIndex + 1})_`
    : ' _(freetext)_';
  return `**> Player**: ${sentence.text}${indicator}`;
}

function formatStateVars(vars: Record<string, unknown>): string {
  const entries = Object.entries(vars);
  if (entries.length === 0) return '_(none)_';
  return entries.map(([k, v]) => `\`${k}=${JSON.stringify(v)}\``).join(', ');
}
