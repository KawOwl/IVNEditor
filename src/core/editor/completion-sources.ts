/**
 * Completion Sources — 编辑器自动补全
 *
 * 三个补全源：
 *   1. `/` 触发 → 工具引用补全（插入 {{tool:xxx}}）
 *   2. `{{state:` 触发 → 状态变量补全（插入 {{state:xxx}}）
 *   3. `{{segment:` 触发 → 片段引用补全（插入 {{segment:xxx}}）
 *
 * 纯逻辑模块，不依赖 React。
 */

import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';

// ============================================================================
// Tool References — 所有可用工具（与 SegmentEditor 共享）
// ============================================================================

export interface ToolReference {
  name: string;
  description: string;
  category: 'mandatory' | 'optional';
}

export const TOOL_REFERENCES: ToolReference[] = [
  // Mandatory
  { name: 'update_state', description: '更新状态变量', category: 'mandatory' },
  { name: 'signal_input_needed', description: '请求玩家输入', category: 'mandatory' },
  // Optional
  { name: 'read_state', description: '读取完整状态快照', category: 'optional' },
  { name: 'query_changelog', description: '查询状态变更记录', category: 'optional' },
  { name: 'pin_memory', description: '固定重要记忆', category: 'optional' },
  { name: 'query_memory', description: '搜索历史记忆', category: 'optional' },
  { name: 'set_mood', description: '设置 UI 氛围', category: 'optional' },
  { name: 'play_sfx', description: '播放音效', category: 'optional' },
  { name: 'show_image', description: '展示插图', category: 'optional' },
  { name: 'roll_dice', description: '掷骰子', category: 'optional' },
];

// ============================================================================
// Completion Source 1: `/` → Tool Reference
// ============================================================================

/**
 * Triggers when user types `/` (at line start or after whitespace).
 * Shows tool list, inserts {{tool:name}} on selection.
 */
export function toolCompletionSource(context: CompletionContext): CompletionResult | null {
  // Match `/` optionally followed by partial tool name
  const word = context.matchBefore(/\/\w*/);
  if (!word) return null;

  // Only trigger at start of line or after whitespace
  if (word.from > 0) {
    const charBefore = context.state.doc.sliceString(word.from - 1, word.from);
    if (charBefore !== '' && charBefore !== ' ' && charBefore !== '\t' && charBefore !== '\n') {
      return null;
    }
  }

  const filter = word.text.slice(1).toLowerCase(); // remove leading `/`

  return {
    from: word.from,
    options: TOOL_REFERENCES
      .filter((t) => !filter || t.name.toLowerCase().includes(filter) || t.description.includes(filter))
      .map((t) => ({
        label: t.name,
        detail: t.description,
        type: t.category === 'mandatory' ? 'method' : 'function',
        apply: `{{tool:${t.name}}}`,
        boost: t.category === 'mandatory' ? 1 : 0,
      })),
    filter: false,
  };
}

// ============================================================================
// Completion Source 2: `{{state:` → State Variable
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
// Completion Source 3: `{{segment:` → Segment Reference
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
