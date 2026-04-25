/**
 * Version Detector — 剧本版本变更检测
 *
 * Step 4.2: 通过 contentHash 比对检测 segment 变更。
 * - logic 类型变更 → 触发重算激活列表
 * - content 类型变更 → 仅更新内容，不重算
 */

import type { PromptSegment, SegmentType } from '#internal/types';

// ============================================================================
// Types
// ============================================================================

export interface SegmentChange {
  segmentId: string;
  label: string;
  type: SegmentType;
  changeType: 'added' | 'removed' | 'modified';
  oldHash?: string;
  newHash?: string;
}

export interface VersionDiff {
  hasChanges: boolean;
  hasLogicChanges: boolean;       // true if any logic segment changed
  hasContentChanges: boolean;     // true if any content segment changed
  changes: SegmentChange[];
  addedSegments: PromptSegment[];
  removedIds: string[];
  modifiedSegments: PromptSegment[];
}

// ============================================================================
// Detect Changes
// ============================================================================

/**
 * Compare saved segment IDs + hashes against current segments.
 * Returns a diff describing what changed.
 */
export function detectVersionChanges(
  savedSegmentIds: string[],
  savedSegmentHashes: Map<string, string>,
  currentSegments: PromptSegment[],
): VersionDiff {
  const currentMap = new Map(currentSegments.map((s) => [s.id, s]));
  const savedIdSet = new Set(savedSegmentIds);

  // Check for removed segments
  const removedChanges = savedSegmentIds
    .filter((savedId) => !currentMap.has(savedId))
    .map((savedId): SegmentChange => ({
      segmentId: savedId,
      label: savedId,
      type: 'content',    // We don't know the type of removed segments
      changeType: 'removed',
      oldHash: savedSegmentHashes.get(savedId),
    }));
  const removedIds = removedChanges.map((change) => change.segmentId);

  // Check for added and modified segments
  const currentChanges = currentSegments.flatMap((segment): SegmentChange[] => {
    if (!savedIdSet.has(segment.id)) {
      return [{
        segmentId: segment.id,
        label: segment.label,
        type: segment.type,
        changeType: 'added',
        newHash: segment.contentHash,
      }];
    }

    const savedHash = savedSegmentHashes.get(segment.id);
    return savedHash && savedHash !== segment.contentHash
      ? [{
          segmentId: segment.id,
          label: segment.label,
          type: segment.type,
          changeType: 'modified',
          oldHash: savedHash,
          newHash: segment.contentHash,
        }]
      : [];
  });
  const changes = [...removedChanges, ...currentChanges];
  const addedSegments = currentSegments.filter((segment) => !savedIdSet.has(segment.id));
  const modifiedSegments = currentSegments.filter((segment) => {
    const savedHash = savedSegmentHashes.get(segment.id);
    return !!savedHash && savedHash !== segment.contentHash;
  });

  const hasChanges = changes.length > 0;
  const hasLogicChanges = changes.some(
    (c) => c.type === 'logic' && (c.changeType === 'modified' || c.changeType === 'added'),
  );
  const hasContentChanges = changes.some(
    (c) => c.type === 'content' && (c.changeType === 'modified' || c.changeType === 'added'),
  );

  return {
    hasChanges,
    hasLogicChanges,
    hasContentChanges,
    changes,
    addedSegments,
    removedIds,
    modifiedSegments,
  };
}

// ============================================================================
// Build Segment Hash Map (for saving)
// ============================================================================

/**
 * Build a hash map from current segments for saving alongside the save data.
 */
export function buildSegmentHashMap(segments: PromptSegment[]): Map<string, string> {
  return new Map(segments.map((s) => [s.id, s.contentHash]));
}

// ============================================================================
// Recompute Active Segments
// ============================================================================

/**
 * After detecting logic changes, recompute which segments should be active.
 * This is called only when hasLogicChanges is true.
 *
 * For now, returns all segment IDs. In a full implementation, this would
 * evaluate injection rules against current state to determine activation.
 */
export function recomputeActiveSegments(
  segments: PromptSegment[],
  stateVars: Record<string, unknown>,
  evaluateCondition: (condition: string, vars: Record<string, unknown>) => boolean,
): string[] {
  return segments
    .filter((seg) => {
      if (!seg.injectionRule) return true;   // No rule = always active
      return evaluateCondition(seg.injectionRule.condition, stateVars);
    })
    .map((seg) => seg.id);
}
