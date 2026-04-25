/**
 * narrative_entries 行的 TS 类型 + 类型守卫。
 *
 * 见 .claude/plans/messages-model.md
 *
 * 这份类型是 server 侧 `NarrativeEntryRow` 的结构化表示 —— 同样的形状，只是
 * 加了按 `kind` 细分的 payload 类型 discriminator，方便 messages-builder 等
 * 纯函数消费。
 *
 * 不 import server/drizzle 类型（core/ 层不能依赖 server/）—— 只定义同构的
 * 纯 TS 接口，使用时由上游适配。
 */

// ============================================================================
// kind 枚举
// ============================================================================

/**
 * 叙事条目的事件类别（migration 0010 / 0011）。
 *
 *   'narrative'    LLM 吐的一段 XML-lite 原文（含 `<d>` 标签）
 *   'signal_input' 一次 signal_input_needed 调用（content=hint，payload={choices}）
 *   'tool_call'    其他工具一次调用（content=toolName，payload={input, output}）
 *   'player_input' 玩家输入（content=文本，payload={selectedIndex?, inputType}）
 */
export type EntryKind = 'narrative' | 'signal_input' | 'tool_call' | 'player_input';

/**
 * 已知 kind 列表 —— 供运行时校验。
 */
export const KNOWN_ENTRY_KINDS: readonly EntryKind[] = [
  'narrative',
  'signal_input',
  'tool_call',
  'player_input',
] as const;

// ============================================================================
// payload 类型
// ============================================================================

/** signal_input kind 的 payload：提问时附带的选项列表 */
export interface SignalInputPayload {
  choices: string[];
}

/** tool_call kind 的 payload：工具调用的完整输入输出 */
export interface ToolCallPayload {
  input: unknown;
  output: unknown;
}

/** player_input kind 的 payload：玩家输入类型 + 选项下标 */
export interface PlayerInputPayload {
  inputType: 'choice' | 'freetext';
  /** 0-based，命中 signal_input 的 choices 数组时有值；freetext 时缺省 */
  selectedIndex?: number;
}

/**
 * payload 联合类型（按 kind 切分）。
 * 'narrative' kind 无 payload（null）。
 */
export type NarrativePayload =
  | SignalInputPayload
  | ToolCallPayload
  | PlayerInputPayload;

// ============================================================================
// NarrativeEntry 主类型
// ============================================================================

/**
 * 一条持久化的叙事条目（server NarrativeEntryRow 的 core 层视图）。
 *
 * 读取时的不变式：
 *   - 按 kind 的配对 payload 必定存在且结构正确（用 is-guards 断言）
 *   - orderIdx 在 playthrough 内单调递增
 *   - batchId nullable（migration 0011，老数据为 null）
 */
export interface NarrativeEntry {
  id: string;
  playthroughId: string;
  role: string;
  kind: EntryKind;
  content: string;
  payload: Record<string, unknown> | null;
  reasoning: string | null;
  finishReason: string | null;
  /** migration 0011：同批 entries 的分组 UUID；老数据 null */
  batchId: string | null;
  orderIdx: number;
  createdAt: Date;
}

// ============================================================================
// Type Guards —— 缩窄 kind + payload 给 messages-builder 用
// ============================================================================

/** 判定 kind 是已知值（运行时输入校验） */
export function isKnownEntryKind(kind: string): kind is EntryKind {
  return (KNOWN_ENTRY_KINDS as readonly string[]).includes(kind);
}

/** kind === 'narrative' —— payload 忽略（应为 null） */
export function isNarrativeEntry(e: NarrativeEntry): e is NarrativeEntry & { kind: 'narrative' } {
  return e.kind === 'narrative';
}

/** kind === 'signal_input' —— 缩窄 payload 为 SignalInputPayload */
export function isSignalInputEntry(
  e: NarrativeEntry,
): e is NarrativeEntry & { kind: 'signal_input'; payload: SignalInputPayload } {
  if (e.kind !== 'signal_input') return false;
  const p = e.payload as { choices?: unknown } | null;
  return !!p && Array.isArray(p.choices);
}

/** kind === 'tool_call' —— 缩窄 payload 为 ToolCallPayload */
export function isToolCallEntry(
  e: NarrativeEntry,
): e is NarrativeEntry & { kind: 'tool_call'; payload: ToolCallPayload } {
  if (e.kind !== 'tool_call') return false;
  const p = e.payload;
  // ToolCallPayload 要求 input / output 两个字段都定义（unknown 可为 null，但 key 必须在）
  return !!p && 'input' in p && 'output' in p;
}

/** kind === 'player_input' —— 缩窄 payload 为 PlayerInputPayload（可选，老数据 payload 可能 null） */
export function isPlayerInputEntry(
  e: NarrativeEntry,
): e is NarrativeEntry & { kind: 'player_input' } {
  return e.kind === 'player_input';
}

/**
 * 安全地从 player_input entry 读 selectedIndex。
 * 老数据 payload 可能为 null，或者 payload.selectedIndex 不是 number —— 都返回 undefined。
 */
export function readSelectedIndex(e: NarrativeEntry): number | undefined {
  if (!isPlayerInputEntry(e)) return undefined;
  const p = e.payload as PlayerInputPayload | null;
  if (!p) return undefined;
  return typeof p.selectedIndex === 'number' ? p.selectedIndex : undefined;
}

/**
 * 安全地从 signal_input entry 读 choices。
 * 不符合期待格式时返回空数组（视图层按"freetext 模式 signal"处理）。
 */
export function readChoices(e: NarrativeEntry): string[] {
  if (!isSignalInputEntry(e)) return [];
  return e.payload.choices;
}
