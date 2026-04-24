/**
 * Completion Sources — 编辑器自动补全
 *
 * 两个补全源：
 *   1. `{{state:` 触发 → 状态变量补全（插入 {{state:xxx}}）
 *   2. `{{segment:` 触发 → 片段引用补全（插入 {{segment:xxx}}）
 *
 * v2.7 之前还有一个 `/` 触发的工具引用补全（插入 {{tool:xxx}}），
 * 但运行时 context-assembler 不会 substitute，LLM 只看到字面标记。
 * 现在统一改为编剧直接写工具的裸名（例如 `read_state`），不走标记化，
 * 所以工具补全已经下线。
 *
 * 纯逻辑模块，不依赖 React。
 */

import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';

// ============================================================================
// Completion Source 1: `{{state:` → State Variable
// ============================================================================

export interface StateVarInfo {
  name: string;
  type: string;
  description?: string;
}

/**
 * Creates a completion source for state variables.
 * Pass the current state schema variables to enable dynamic completion.
 */
export function createStateCompletionSource(getStateVars: () => StateVarInfo[]) {
  return function stateCompletionSource(context: CompletionContext): CompletionResult | null {
    const word = context.matchBefore(/\{\{state:\w*/);
    if (!word) return null;

    const prefix = '{{state:';
    const filter = word.text.slice(prefix.length).toLowerCase();
    const vars = getStateVars();

    return {
      from: word.from,
      options: vars
        .filter((v) => !filter || v.name.toLowerCase().includes(filter))
        .map((v) => ({
          label: `{{state:${v.name}}}`,
          displayLabel: v.name,
          detail: `${v.type}${v.description ? ' — ' + v.description : ''}`,
          type: 'variable',
          apply: `{{state:${v.name}}}`,
        })),
      filter: false,
    };
  };
}

// ============================================================================
// Completion Source 2: `{{segment:` → Segment Reference
// ============================================================================

export interface SegmentInfo {
  id: string;
  label: string;
}

/**
 * Creates a completion source for segment references.
 */
export function createSegmentCompletionSource(getSegments: () => SegmentInfo[]) {
  return function segmentCompletionSource(context: CompletionContext): CompletionResult | null {
    const word = context.matchBefore(/\{\{segment:\w*/);
    if (!word) return null;

    const prefix = '{{segment:';
    const filter = word.text.slice(prefix.length).toLowerCase();
    const segments = getSegments();

    return {
      from: word.from,
      options: segments
        .filter((s) => !filter || s.id.toLowerCase().includes(filter) || s.label.toLowerCase().includes(filter))
        .map((s) => ({
          label: `{{segment:${s.id}}}`,
          displayLabel: s.id,
          detail: s.label,
          type: 'class',
          apply: `{{segment:${s.id}}}`,
        })),
      filter: false,
    };
  };
}
