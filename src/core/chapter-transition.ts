/**
 * Chapter Transition — 跨章继承（state only）
 *
 * 三层 fallback 机制继续保留（显式 inherit/exclude + Architect 自动推断 +
 * GM 运行时补充），但**只作用于 state**，不再管 memory。
 *
 * 为什么不管 memory：
 *   - 章节不是 memory 的生命周期事件
 *   - 记忆压缩节奏完全由 adapter 内部按 budget 自决
 *   - 如果外部确实希望"章节切换清空记忆"，显式在章节切换逻辑里调
 *     newMemory.reset()（激进）或继续累积（默认）
 *
 * Note: 本函数目前在仓库里**从未被调用**（审计报告 2026-04-19），是死代码。
 * 保留定义作为未来章节切换 state 迁移的占位实现。
 */

import type {
  CrossChapterConfig,
  StateSchema,
  InheritanceSnapshot,
} from './types';
import type { StateStore } from './state-store';

// ============================================================================
// Types
// ============================================================================

export interface ChapterTransitionInput {
  /** Previous chapter's state store */
  prevState: StateStore;
  /** New chapter's state schema */
  nextStateSchema: StateSchema;
  /** Cross-chapter config (from Architect Agent + editor confirmation) */
  crossChapterConfig: CrossChapterConfig;
}

export interface ChapterTransitionResult {
  /** Inherited state variables (key → value) */
  inheritedState: Record<string, unknown>;
  /** Snapshot for archival */
  snapshot: InheritanceSnapshot;
}

// ============================================================================
// Execute Transition
// ============================================================================

export async function executeChapterTransition(
  input: ChapterTransitionInput,
): Promise<ChapterTransitionResult> {
  const {
    prevState,
    nextStateSchema,
    crossChapterConfig,
  } = input;

  // --- Layer 1: Explicit declaration ---
  const explicitInherit = new Set(crossChapterConfig.inherit);
  const explicitExclude = new Set(crossChapterConfig.exclude);

  // --- Layer 2: Auto-inference (same-named fields) ---
  const nextFieldNames = new Set(nextStateSchema.variables.map((v) => v.name));
  const prevStateData = prevState.export();

  const inheritedState: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(prevStateData)) {
    // Skip explicitly excluded
    if (explicitExclude.has(key)) continue;

    // Include if explicitly declared OR if same-named field exists in next chapter
    if (explicitInherit.has(key) || nextFieldNames.has(key)) {
      inheritedState[key] = value;
    }
  }

  // --- Build snapshot ---
  const snapshot: InheritanceSnapshot = {
    fromChapter: 'prev', // Will be set by caller with actual chapter ID
    toChapter: 'next',   // Will be set by caller
    timestamp: Date.now(),
    fields: inheritedState,
  };

  return {
    inheritedState,
    snapshot,
  };
}

// ============================================================================
// Apply Transition to New Chapter
// ============================================================================

/**
 * Apply the transition result to a new chapter's state store.
 *
 * Memory 不再在这里处理。如果外层需要"章节切换时清空 memory"，
 * 单独调 newMemory.reset()；默认是"memory 跨章继续累积"。
 */
export function applyTransitionResult(
  result: ChapterTransitionResult,
  newState: StateStore,
): void {
  for (const [key, value] of Object.entries(result.inheritedState)) {
    newState.set(key, value, 'system');
  }
}
