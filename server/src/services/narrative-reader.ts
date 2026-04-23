/**
 * NarrativeHistoryReader 的 server 端实现 —— 走 PlaythroughService 查 DB。
 *
 * 见 .claude/plans/messages-model.md
 *
 * 给 memory adapter（未来）和 messages-builder 消费路径用。PR-M1 里先落地，
 * 暂无生产消费者。
 */

import type {
  NarrativeHistoryReader,
} from '../../../src/core/memory/narrative-reader';
import type { EntryKind, NarrativeEntry } from '../../../src/core/persistence-entry';
import { isKnownEntryKind } from '../../../src/core/persistence-entry';
import { playthroughService, type NarrativeEntryRow } from './playthrough-service';

/** DB Row → core 层 NarrativeEntry */
function rowToEntry(row: NarrativeEntryRow): NarrativeEntry {
  // DB kind 列允许任意 text；未知值兜底为 'narrative'（记一条 console.warn 便于观测）
  let kind: EntryKind;
  if (isKnownEntryKind(row.kind)) {
    kind = row.kind;
  } else {
    console.warn(`[narrative-reader] unknown kind "${row.kind}" for entry ${row.id} → fallback 'narrative'`);
    kind = 'narrative';
  }
  return {
    id: row.id,
    playthroughId: row.playthroughId,
    role: row.role,
    kind,
    content: row.content,
    payload: row.payload,
    reasoning: row.reasoning,
    finishReason: row.finishReason,
    batchId: row.batchId,
    orderIdx: row.orderIdx,
    createdAt: row.createdAt,
  };
}

/**
 * 为指定 playthrough 创建 NarrativeHistoryReader。
 *
 * 典型用法：
 *   const reader = createNarrativeHistoryReader(playthroughId);
 *   const recent = await reader.readRecent({ limit: 50 });
 */
export function createNarrativeHistoryReader(
  playthroughId: string,
): NarrativeHistoryReader {
  return {
    async readRecent({ limit, kinds }) {
      // playthroughService.loadEntries 已经按 orderIdx 升序返回 + 分页
      const rows = await playthroughService.loadEntries(playthroughId, limit, 0);
      const entries = rows.map(rowToEntry);
      return kinds && kinds.length > 0
        ? entries.filter((e) => kinds.includes(e.kind))
        : entries;
    },

    async readRange({ fromOrderIdx, toOrderIdx }) {
      const rows = await playthroughService.loadEntriesInRange(
        playthroughId,
        fromOrderIdx,
        toOrderIdx,
      );
      return rows.map(rowToEntry);
    },
  };
}
