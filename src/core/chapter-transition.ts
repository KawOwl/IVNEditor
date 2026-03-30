/**
 * Chapter Transition — 跨章继承
 *
 * Step 4.3: 三层 fallback 机制 + 继承快照。
 *   1. 编剧显式声明（inherit/exclude 列表）— 最高优先级
 *   2. Architect Agent 自动推断（同名字段默认继承）— 兜底
 *   3. GM 运行时补充（通过 pin_memory 标记）— 可选补充
 *
 * 继承快照保存在 SaveData 中，可回溯。
 */

import type {
  CrossChapterConfig,
  StateSchema,
  InheritanceSnapshot,
} from './types';
import type { StateStore } from './state-store';
import type { MemoryManager, CompressFn } from './memory';

// ============================================================================
// Types
// ============================================================================

export interface ChapterTransitionInput {
  /** Previous chapter's state store */
  prevState: StateStore;
  /** Previous chapter's memory manager */
  prevMemory: MemoryManager;
  /** New chapter's state schema */
  nextStateSchema: StateSchema;
  /** Cross-chapter config (from Architect Agent + editor confirmation) */
  crossChapterConfig: CrossChapterConfig;
  /** Compress function for memory summarization */
  compressFn: CompressFn;
}

export interface ChapterTransitionResult {
  /** Inherited state variables (key → value) */
  inheritedState: Record<string, unknown>;
  /** Inherited memory summary */
  inheritedMemorySummary: string;
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
    prevMemory,
    nextStateSchema,
    crossChapterConfig,
    compressFn,
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

  // --- Layer 3: Memory inheritance ---
  // Compress all memory from previous chapter into a summary
  await prevMemory.compressAll(compressFn);
  const summaries = prevMemory.getSummaries();
  const pinnedEntries = prevMemory.getPinnedEntries();

  // Build inherited summary: summaries + pinned items
  const summaryParts = [
    ...summaries,
    ...pinnedEntries.map((e) => `[重要] ${e.content}`),
  ];
  const inheritedMemorySummary = summaryParts.join('\n\n');

  // --- Build snapshot ---
  const snapshot: InheritanceSnapshot = {
    fromChapter: 'prev', // Will be set by caller with actual chapter ID
    toChapter: 'next',   // Will be set by caller
    timestamp: Date.now(),
    fields: inheritedState,
    summary: inheritedMemorySummary,
  };

  return {
    inheritedState,
    inheritedMemorySummary,
    snapshot,
  };
}

// ============================================================================
// Apply Transition to New Chapter
// ============================================================================

/**
 * Apply the transition result to a new chapter's state store and memory manager.
 */
export function applyTransitionResult(
  result: ChapterTransitionResult,
  newState: StateStore,
  newMemory: MemoryManager,
): void {
  // Import inherited state
  for (const [key, value] of Object.entries(result.inheritedState)) {
    newState.set(key, value, 'system');
  }

  // Set inherited memory summary
  newMemory.setInheritedSummary(result.inheritedMemorySummary);
}
