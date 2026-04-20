/**
 * PlaythroughService — 游玩记录业务逻辑层
 *
 * 封装 playthrough + narrative_entries 的所有数据库操作。
 * Route 层只负责 HTTP/参数处理，不直接访问 db/schema。
 */

import { eq, and, desc, asc, sql, inArray } from 'drizzle-orm';
import { db, schema } from '../db';

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
  memoryEntries: unknown[] | null;
  memorySummaries: string[] | null;
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
  content: string;
  reasoning: string | null;
  toolCalls: unknown[] | null;
  finishReason: string | null;
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
    const conditions = [eq(schema.playthroughs.userId, filter.userId)];
    if (!filter.includeArchived) {
      conditions.push(eq(schema.playthroughs.archived, false));
    }
    // scriptVersionIds（数组）优先于 scriptVersionId（单个）
    if (filter.scriptVersionIds && filter.scriptVersionIds.length > 0) {
      conditions.push(inArray(schema.playthroughs.scriptVersionId, filter.scriptVersionIds));
    } else if (filter.scriptVersionId) {
      conditions.push(eq(schema.playthroughs.scriptVersionId, filter.scriptVersionId));
    }
    if (filter.kind) {
      conditions.push(eq(schema.playthroughs.kind, filter.kind));
    }

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
      memoryEntries: [],
      memorySummaries: [],
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
      memoryEntries: pt.memoryEntries,
      memorySummaries: pt.memorySummaries,
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
      memoryEntries: unknown[];
      memorySummaries: string[];
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
   */
  async appendNarrativeEntry(entry: {
    playthroughId: string;
    role: string;
    content: string;
    reasoning?: string | null;
    toolCalls?: unknown[] | null;
    finishReason?: string | null;
  }): Promise<string> {
    const id = crypto.randomUUID();

    // 用事务保证 max(orderIdx) 查询和 insert 的原子性，
    // 防止并发 GameSession 写入导致 orderIdx 重复（P1 修复）。
    await db.transaction(async (tx) => {
      const maxResult = await tx
        .select({ max: sql<number>`coalesce(max(${schema.narrativeEntries.orderIdx}), -1)` })
        .from(schema.narrativeEntries)
        .where(eq(schema.narrativeEntries.playthroughId, entry.playthroughId));
      const nextIdx = Number(maxResult[0]?.max ?? -1) + 1;

      await tx.insert(schema.narrativeEntries).values({
        id,
        playthroughId: entry.playthroughId,
        role: entry.role,
        content: entry.content,
        reasoning: entry.reasoning ?? null,
        toolCalls: entry.toolCalls ?? null,
        finishReason: entry.finishReason ?? null,
        orderIdx: nextIdx,
      });
    });

    return id;
  }

  /**
   * 加载 entries（分页，用于恢复）
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
}

// 单例导出
export const playthroughService = new PlaythroughService();
