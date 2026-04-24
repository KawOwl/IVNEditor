/**
 * NarrativeHistoryReader —— memory adapter 从 narrative_entries 读历史的接口。
 *
 * 见 .claude/plans/messages-model.md
 *
 * 定位：
 *   - memory adapter 的内部依赖（不是 coreLoop 直接依赖）
 *   - 让 adapter 不再自己持有一份对话 entries 副本，而是按需从 canonical
 *     narrative_entries 拉取
 *   - PR-M1 里先定义接口 + server 端实现，adapter 暂不切换；未来 memory
 *     refactor 时让 legacy / mem0 / LLMSummarizer 都注入一个 reader 实例
 *
 * 实现注意：
 *   - 所有方法返回的 entries 按 orderIdx 升序排序
 *   - 实现可能查 DB，需要是 async 的
 *   - 纯读接口，无副作用（不影响持久化状态）
 */

import type { EntryKind, NarrativeEntry } from '#internal/persistence-entry';

export interface NarrativeHistoryReader {
  /**
   * 读最近 N 条 entries（orderIdx 升序）。
   * @param opts.limit 最大条数
   * @param opts.kinds 可选按 kind 白名单过滤（不传 = 全部 kind）
   */
  readRecent(opts: { limit: number; kinds?: EntryKind[] }): Promise<NarrativeEntry[]>;

  /**
   * 按 orderIdx 范围读 entries（闭区间，升序）。
   * 任一端 undefined 表示该方向无约束。
   */
  readRange(opts: { fromOrderIdx?: number; toOrderIdx?: number }): Promise<NarrativeEntry[]>;

  // 未来扩展点：readPinned() / readByBatchId(batchId) / readCount() 等
}
