/**
 * PlaythroughService — 游玩记录业务逻辑层
 *
 * 封装 playthrough + narrative_entries 的所有数据库操作。
 * Route 层只负责 HTTP/参数处理，不直接访问 db/schema。
 */

import { eq, and, desc, asc, sql, inArray } from 'drizzle-orm';
import { db, schema } from '#internal/db';

const defined = <T,>(value: T | undefined): value is T => value !== undefined;

// ============================================================================
// Types
// ============================================================================

/** 列表查询筛选条件 */
export interface ListFilter {
  /** 必填：只返回该用户的记录（ownership 隔离） */
  userId: string;
  /** 按单个版本 id 过滤（编辑器试玩用） */
  scriptVersionId?: string;
  /**
   * 按多个版本 id 过滤（玩家流用：把 script 的所有历史版本展开成数组）。
   * 传了 scriptVersionIds 时 scriptVersionId 被忽略。
   */
  scriptVersionIds?: string[];
  includeArchived?: boolean;
  /** 'production' | 'playtest'，不传返回全部 */
  kind?: 'production' | 'playtest';
}

/** 列表项（不含 entries，用于列表展示） */
export interface PlaythroughSummary {
  id: string;
  scriptVersionId: string;
  kind: string;
  title: string | null;
  turn: number;
  status: string;
  preview: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 创建参数 */
export interface CreateInput {
  /** 必填：归属的 user */
  userId: string;
  scriptVersionId: string;
  chapterId: string;
  title?: string | null;
  /** 'production' | 'playtest'，默认 'production' */
  kind?: 'production' | 'playtest';
  /** v2.7：必填，创建时固化的 llm config id */
  llmConfigId: string;
}

/** 更新参数 */
export interface UpdateInput {
  title?: string;
  archived?: boolean;
}

/** 详情（含 entries 分页） */
export interface PlaythroughDetail {
  id: string;
  scriptVersionId: string;
  /** v2.7：创建时固化的 llm config id */
  llmConfigId: string;
  kind: string;
  title: string | null;
  chapterId: string;
  status: string;
  turn: number;
  stateVars: Record<string, unknown> | null;
  /**
   * Memory adapter 的 opaque snapshot（0009_memory_snapshot 合并后）。
   * legacy 格式：{ kind:'legacy-v1', entries, summaries }
   */
  memorySnapshot: Record<string, unknown> | null;
  inputHint: string | null;
  inputType: string;
  choices: string[] | null;
  preview: string | null;
  /** M3: VN 场景快照（断线重连恢复视觉用） */
  currentScene: {
    background: string | null;
    sprites: Array<{ id: string; emotion: string; position?: string }>;
  } | null;
  /** M3: 玩家推进到第几条 Sentence（M2 用，M3 阶段 null） */
  sentenceIndex: number | null;
  createdAt: Date;
  updatedAt: Date;
  entries: NarrativeEntryRow[];
  totalEntries: number;
  hasMore: boolean;
}

/** narrative_entries 行 */
export interface NarrativeEntryRow {
  id: string;
  playthroughId: string;
  role: string;
  /**
   * 事件类别（migration 0010 / 0011）：
   *   'narrative' | 'signal_input' | 'tool_call' | 'player_input'
   * 见 .claude/plans/messages-model.md
   */
  kind: string;
  content: string;
  reasoning: string | null;
  /** 按 kind 自描述的结构化载荷（migration 0010 取代 tool_calls dead column） */
  payload: Record<string, unknown> | null;
  finishReason: string | null;
  /**
   * 同批 entries 的分组标记（migration 0011），见 messages-model.md。
   * 0010 之前老数据为 null；视图层走启发式兜底。
   */
  batchId: string | null;
  orderIdx: number;
  createdAt: Date;
}

// ============================================================================
// Service
// ============================================================================

export class PlaythroughService {
  /**
   * 列出游玩记录（按 updatedAt 降序）
   */
  async list(filter: ListFilter): Promise<PlaythroughSummary[]> {
    // userId 必填 → 强制按用户隔离
    // scriptVersionIds（数组）优先于 scriptVersionId（单个）
    const versionCondition = filter.scriptVersionIds && filter.scriptVersionIds.length > 0
      ? inArray(schema.playthroughs.scriptVersionId, filter.scriptVersionIds)
      : filter.scriptVersionId
        ? eq(schema.playthroughs.scriptVersionId, filter.scriptVersionId)
        : undefined;
    const conditions = [
      eq(schema.playthroughs.userId, filter.userId),
      !filter.includeArchived ? eq(schema.playthroughs.archived, false) : undefined,
      versionCondition,
      filter.kind ? eq(schema.playthroughs.kind, filter.kind) : undefined,
    ].filter(defined);

    const rows = await db
      .select({
        id: schema.playthroughs.id,
        scriptVersionId: schema.playthroughs.scriptVersionId,
        kind: schema.playthroughs.kind,
        title: schema.playthroughs.title,
        turn: schema.playthroughs.turn,
        status: schema.playthroughs.status,
        preview: schema.playthroughs.preview,
        createdAt: schema.playthroughs.createdAt,
        updatedAt: schema.playthroughs.updatedAt,
      })
      .from(schema.playthroughs)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.playthroughs.updatedAt))
      .limit(100);

    return rows;
  }

  /**
   * 创建新游玩记录
   */
  async create(input: CreateInput): Promise<{ id: string; title: string }> {
    // 自动生成标题
    let title = input.title ?? null;
    if (!title) {
      const countResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.playthroughs)
        .where(
          and(
            eq(schema.playthroughs.scriptVersionId, input.scriptVersionId),
            eq(schema.playthroughs.userId, input.userId),
          ),
        );
      const existing = Number(countResult[0]?.count ?? 0);
      title = `游玩 #${existing + 1}`;
    }

    const id = crypto.randomUUID();

    await db.insert(schema.playthroughs).values({
      id,
      userId: input.userId,
      scriptVersionId: input.scriptVersionId,
      llmConfigId: input.llmConfigId,
      kind: input.kind ?? 'production',
      title,
      chapterId: input.chapterId,
      status: 'idle',
      turn: 0,
      stateVars: {},
      // 首次 insert 时不填 snapshot —— LegacyMemory.restore 对 undefined
      // 或空 object 都能安全兜底为空 entries/summaries。
      memorySnapshot: null,
    });

    return { id, title };
  }

  /**
   * 获取游玩详情 + entries（分页）
   * 必须传 userId，只返回该用户自己的记录。
   * 不归属当前用户 或 不存在 → 都返回 null（对外都是 404，避免信息泄漏）。
   */
  async getById(
    id: string,
    userId: string,
    entriesLimit = 50,
    entriesOffset = 0,
  ): Promise<PlaythroughDetail | null> {
    const rows = await db
      .select()
      .from(schema.playthroughs)
      .where(and(eq(schema.playthroughs.id, id), eq(schema.playthroughs.userId, userId)))
      .limit(1);

    if (rows.length === 0) return null;
    const pt = rows[0];

    const entries = await db
      .select()
      .from(schema.narrativeEntries)
      .where(eq(schema.narrativeEntries.playthroughId, id))
      .orderBy(asc(schema.narrativeEntries.orderIdx))
      .limit(entriesLimit)
      .offset(entriesOffset);

    const countResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.narrativeEntries)
      .where(eq(schema.narrativeEntries.playthroughId, id));
    const totalEntries = Number(countResult[0]?.count ?? 0);

    return {
      id: pt.id,
      scriptVersionId: pt.scriptVersionId,
      llmConfigId: pt.llmConfigId,
      kind: pt.kind,
      title: pt.title,
      chapterId: pt.chapterId,
      status: pt.status,
      turn: pt.turn,
      stateVars: pt.stateVars,
      memorySnapshot: pt.memorySnapshot,
      inputHint: pt.inputHint,
      inputType: pt.inputType,
      choices: pt.choices,
      preview: pt.preview,
      currentScene: pt.currentScene ?? null,
      sentenceIndex: pt.sentenceIndex,
      createdAt: pt.createdAt,
      updatedAt: pt.updatedAt,
      entries: entries as NarrativeEntryRow[],
      totalEntries,
      hasMore: entriesOffset + entries.length < totalEntries,
    };
  }

  /**
   * 更新游玩记录（改标题/归档）
   * 必须传 userId；不属于该用户的记录直接视为不存在（返回 false）。
   *
   * updatedAt 使用 DB 的 NOW() 而非 JS Date，避免本地和 DB 时钟漂移
   * 导致 updatedAt 反向的问题（测试 runner 时钟 < DB 时钟时会触发）。
   */
  async update(id: string, userId: string, input: UpdateInput): Promise<boolean> {
    const patch: Record<string, unknown> = { updatedAt: sql`NOW()` };
    if (input.title !== undefined) patch.title = input.title;
    if (input.archived !== undefined) patch.archived = input.archived;

    const result = await db
      .update(schema.playthroughs)
      .set(patch)
      .where(and(eq(schema.playthroughs.id, id), eq(schema.playthroughs.userId, userId)))
      .returning({ id: schema.playthroughs.id });

    return result.length > 0;
  }

  /**
   * 硬删除（narrative_entries 通过 CASCADE 自动删除）
   * 必须传 userId；不属于该用户的记录直接视为不存在（返回 false）。
   */
  async delete(id: string, userId: string): Promise<boolean> {
    const result = await db
      .delete(schema.playthroughs)
      .where(and(eq(schema.playthroughs.id, id), eq(schema.playthroughs.userId, userId)))
      .returning({ id: schema.playthroughs.id });

    return result.length > 0;
  }

  /**
   * 统计某用户的某剧本版本游玩数
   */
  async countByScriptVersionAndUser(scriptVersionId: string, userId: string): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.playthroughs)
      .where(
        and(
          eq(schema.playthroughs.scriptVersionId, scriptVersionId),
          eq(schema.playthroughs.userId, userId),
        ),
      );

    return Number(result[0]?.count ?? 0);
  }

  /**
   * 仅用于内部：按 id 查 playthrough 的 userId（做 ownership 校验用）
   * 返回 userId 或 null（不存在）
   */
  async getOwnerId(id: string): Promise<string | null> {
    const rows = await db
      .select({ userId: schema.playthroughs.userId })
      .from(schema.playthroughs)
      .where(eq(schema.playthroughs.id, id))
      .limit(1);
    return rows[0]?.userId ?? null;
  }

  // ============================================================================
  // Persistence helpers（供 GameSession 持久化调用）
  // ============================================================================

  /**
   * 更新 playthrough 状态字段（状态转换时调用）
   */
  async updateState(
    id: string,
    patch: Partial<{
      status: string;
      turn: number;
      stateVars: Record<string, unknown>;
      memorySnapshot: Record<string, unknown>;
      inputHint: string | null;
      inputType: string;
      choices: string[] | null;
      preview: string | null;
      /** M3: VN 场景快照 */
      currentScene: {
        background: string | null;
        sprites: Array<{ id: string; emotion: string; position?: string }>;
      } | null;
      /** M3: 玩家推进到第几条 Sentence */
      sentenceIndex: number | null;
    }>,
  ): Promise<void> {
    await db
      .update(schema.playthroughs)
      .set({ ...patch, updatedAt: sql`NOW()` })
      .where(eq(schema.playthroughs.id, id));
  }

  /**
   * 追加叙事条目
   *
   * kind 默认 'narrative'。signal_input / tool_call / player_input 条目走同一个入口，
   * 只是 kind + payload 不同，见 .claude/plans/messages-model.md。
   */
  async appendNarrativeEntry(entry: {
    playthroughId: string;
    role: string;
    kind?: string;                       // 默认 'narrative'（migration 0010）
    content: string;
    reasoning?: string | null;
    payload?: Record<string, unknown> | null;  // migration 0010 取代 tool_calls
    finishReason?: string | null;
    /**
     * migration 0011：同一 LLM step / 玩家一次提交产出的 entries 共享的 UUID。
     * nullable，不传视为 null（老行为兼容）。
     */
    batchId?: string | null;
  }): Promise<string> {
    const id = crypto.randomUUID();

    // 用 per-playthrough transaction-level advisory lock 串行化 max(orderIdx)
    // 查询和 insert。普通 READ COMMITTED 事务本身不足以防止两个并发 writer
    // 同时读到相同 max 值。
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        select pg_advisory_xact_lock(hashtext(${entry.playthroughId}), 0)
      `);

      const maxResult = await tx
        .select({ max: sql<number>`coalesce(max(${schema.narrativeEntries.orderIdx}), -1)` })
        .from(schema.narrativeEntries)
        .where(eq(schema.narrativeEntries.playthroughId, entry.playthroughId));
      const nextIdx = Number(maxResult[0]?.max ?? -1) + 1;

      await tx.insert(schema.narrativeEntries).values({
        id,
        playthroughId: entry.playthroughId,
        role: entry.role,
        kind: entry.kind ?? 'narrative',
        content: entry.content,
        reasoning: entry.reasoning ?? null,
        payload: entry.payload ?? null,
        finishReason: entry.finishReason ?? null,
        batchId: entry.batchId ?? null,
        orderIdx: nextIdx,
      });
    });

    return id;
  }

  /**
   * 分页加载 entries —— **向前**语义（offset=N 跳过最早 N 条，limit=K 取接下来 K 条）。
   *
   * 典型用法：WS 'restored' 消息给客户端回放前 N 条叙事做 UI 恢复。
   *
   * ⚠️ 不要用这个读"最近 N 条历史"喂 LLM —— 那是 loadLatestEntries 的职责。
   * 之前 narrative-reader.readRecent 误用了 loadEntries(limit, 0)，结果 LLM
   * 在长 session 里永远看到的是最早的 N 条（orderIdx 0-N），最近的 turn
   * 对 LLM 完全不可见（session 85a8c5c0 reload 后"进度丢失"复盘发现）。
   */
  async loadEntries(
    playthroughId: string,
    limit: number,
    offset = 0,
  ): Promise<NarrativeEntryRow[]> {
    return await db
      .select()
      .from(schema.narrativeEntries)
      .where(eq(schema.narrativeEntries.playthroughId, playthroughId))
      .orderBy(asc(schema.narrativeEntries.orderIdx))
      .limit(limit)
      .offset(offset) as NarrativeEntryRow[];
  }

  /**
   * 统计 playthrough 的 entries 总数（Bug C v29，2026-04-24）。
   *
   * 用途：GET /:id/entries 分页端点要让客户端判断是否还有更多可取。
   * 单独抽一个方法避免 caller 重复写 count sql。
   */
  async countEntries(playthroughId: string): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.narrativeEntries)
      .where(eq(schema.narrativeEntries.playthroughId, playthroughId));
    return Number(result[0]?.count ?? 0);
  }

  /**
   * 加载"最近 N 条"entries（按 orderIdx 升序返回，即 chronological order）。
   *
   * 实现：DB 侧 DESC + limit N 拿到最新 N 条，之后在内存反转成 ASC 返回
   *      —— 下游 messages-builder / memory adapter 都假设输入是 ASC 排序。
   *
   * 典型用法：memory.getRecentAsMessages 通过 NarrativeHistoryReader.readRecent
   *      拉最近 N 条喂 LLM。
   */
  async loadLatestEntries(
    playthroughId: string,
    limit: number,
  ): Promise<NarrativeEntryRow[]> {
    const rows = await db
      .select()
      .from(schema.narrativeEntries)
      .where(eq(schema.narrativeEntries.playthroughId, playthroughId))
      .orderBy(desc(schema.narrativeEntries.orderIdx))
      .limit(limit) as NarrativeEntryRow[];
    return rows.reverse();
  }

  /**
   * 加载 orderIdx 在 [fromOrderIdx, toOrderIdx] 区间内的 entries（闭区间，升序）。
   * 任一端为 undefined 即不设约束。供 NarrativeHistoryReader.readRange 使用。
   */
  async loadEntriesInRange(
    playthroughId: string,
    fromOrderIdx?: number,
    toOrderIdx?: number,
  ): Promise<NarrativeEntryRow[]> {
    const conditions = [
      eq(schema.narrativeEntries.playthroughId, playthroughId),
      fromOrderIdx !== undefined
        ? sql`${schema.narrativeEntries.orderIdx} >= ${fromOrderIdx}`
        : undefined,
      toOrderIdx !== undefined
        ? sql`${schema.narrativeEntries.orderIdx} <= ${toOrderIdx}`
        : undefined,
    ].filter(defined);
    return await db
      .select()
      .from(schema.narrativeEntries)
      .where(and(...conditions))
      .orderBy(asc(schema.narrativeEntries.orderIdx)) as NarrativeEntryRow[];
  }
}

// 单例导出
export const playthroughService = new PlaythroughService();
