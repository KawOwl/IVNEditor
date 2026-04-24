/**
 * StateStore — ScriptState KV 存储 + Changelog 独立存储
 *
 * ScriptState: 当前快照，get/set/update(patch)/serialize
 * Changelog: 独立的变更历史，append/query，永不压缩
 */

import type {
  ScriptState,
  StateSchema,
  ChangelogEntry,
  ChangelogFilter,
} from './types';

// ============================================================================
// ID Generator
// ============================================================================

let counter = 0;
function generateId(): string {
  return `${Date.now()}-${++counter}`;
}

// ============================================================================
// StateStore
// ============================================================================

export class StateStore {
  private state: ScriptState;
  private changelog: ChangelogEntry[] = [];
  private currentTurn = 0;

  constructor(schema: StateSchema) {
    // Initialize state from schema defaults
    const vars: Record<string, unknown> = {};
    for (const variable of schema.variables) {
      vars[variable.name] = structuredClone(variable.initial);
    }
    this.state = { vars };
  }

  // --- Read ---

  get(key: string): unknown {
    return this.state.vars[key];
  }

  getAll(): Record<string, unknown> {
    return structuredClone(this.state.vars);
  }

  getKeys(keys: string[]): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key in this.state.vars) {
        result[key] = this.state.vars[key];
      }
    }
    return structuredClone(result);
  }

  // --- Write ---

  set(
    key: string,
    value: unknown,
    source: ChangelogEntry['source'] = 'system',
  ): void {
    const prev = this.state.vars[key];
    this.state.vars[key] = structuredClone(value);
    this.appendChangelogEntry(key, prev, value, source);
  }

  update(
    patch: Record<string, unknown>,
    source: ChangelogEntry['source'] = 'llm',
  ): void {
    for (const [key, value] of Object.entries(patch)) {
      const prev = this.state.vars[key];
      this.state.vars[key] = structuredClone(value);
      this.appendChangelogEntry(key, prev, value, source);
    }
  }

  // --- Serialization ---

  /** Serialize state to YAML-like string for prompt injection */
  serialize(): string {
    return serializeStateVars(this.state.vars);
  }

  /** Export full state for save/cross-chapter */
  export(): ScriptState {
    return structuredClone(this.state);
  }

  /** Import state (for load/cross-chapter) */
  import(state: ScriptState): void {
    this.state = structuredClone(state);
  }

  /**
   * 从持久化快照恢复（DB 中存的是 stateVars + turn）
   */
  restore(vars: Record<string, unknown>, turn: number): void {
    this.state.vars = structuredClone(vars);
    this.currentTurn = turn;
  }

  // --- Turn Management ---

  setTurn(turn: number): void {
    this.currentTurn = turn;
  }

  getTurn(): number {
    return this.currentTurn;
  }

  // --- Changelog ---

  private appendChangelogEntry(
    key: string,
    previousValue: unknown,
    newValue: unknown,
    source: ChangelogEntry['source'],
  ): void {
    this.changelog.push({
      id: generateId(),
      turn: this.currentTurn,
      timestamp: Date.now(),
      key,
      previousValue: structuredClone(previousValue),
      newValue: structuredClone(newValue),
      source,
    });
  }

  queryChangelog(filter: ChangelogFilter = {}): ChangelogEntry[] {
    return this.changelog.filter((entry) => {
      if (filter.key !== undefined && entry.key !== filter.key) return false;
      if (filter.source !== undefined && entry.source !== filter.source) return false;
      if (filter.turnRange !== undefined) {
        const [min, max] = filter.turnRange;
        if (entry.turn < min || entry.turn > max) return false;
      }
      if (filter.timeRange !== undefined) {
        const [min, max] = filter.timeRange;
        if (entry.timestamp < min || entry.timestamp > max) return false;
      }
      return true;
    });
  }

  getFullChangelog(): ChangelogEntry[] {
    return [...this.changelog];
  }

  /** Export changelog for save */
  exportChangelog(): ChangelogEntry[] {
    return structuredClone(this.changelog);
  }

  /** Import changelog (for load) */
  importChangelog(entries: ChangelogEntry[]): void {
    this.changelog = structuredClone(entries);
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * 序列化状态变量为 YAML-like 字符串。
 *
 * 无缩进、每行一个 `key: value`。对不同类型的 value：
 * - string → 原样（不加引号）
 * - number / boolean → String()
 * - array / object → JSON.stringify
 * - null / undefined → 'null'
 *
 * 导出为独立函数以便 context-assembler 的预览路径（没有 StateStore 实例时）
 * 也能用同一套格式生成 INTERNAL_STATE section，和运行时保持一致。
 */
export function serializeStateVars(vars: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(vars)) {
    lines.push(`${key}: ${formatValue(value)}`);
  }
  return lines.join('\n');
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
