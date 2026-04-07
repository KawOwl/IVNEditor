/**
 * PlaythroughService — 游玩记录业务逻辑层
 *
 * 封装 playthrough + narrative_entries 的所有数据库操作。
 * Route 层只负责 HTTP/参数处理，不直接访问 db/schema。
 */

import { eq, and, desc, asc, sql } from 'drizzle-orm';
import { db, schema } from '../db';

// ============================================================================
// Types
// ============================================================================

/** 列表查询筛选条件 */
export interface ListFilter {
  scriptId?: string;
  playerId?: string;
  includeArchived?: boolean;
}

/** 列表项（不含 entries，用于列表展示） */
export interface PlaythroughSummary {
  id: string;
  scriptId: string;
  title: string | null;
  turn: number;
  status: string;
  preview: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 创建参数 */
export interface CreateInput {
  scriptId: string;
  chapterId: string;
  playerId?: string | null;
  title?: string | null;
}

/** 更新参数 */
export interface UpdateInput {
  title?: string;
  archived?: boolean;
}

/** 详情（含 entries 分页） */
export interface PlaythroughDetail {
  id: string;
  scriptId: string;
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
  async list(filter: ListFilter = {}): Promise<PlaythroughSummary[]> {
    const conditions = [];
    if (!filter.includeArchived) {
      conditions.push(eq(schema.playthroughs.archived, false));
    }
    if (filter.scriptId) {
      conditions.push(eq(schema.playthroughs.scriptId, filter.scriptId));
    }
    if (filter.playerId) {
      conditions.push(eq(schema.playthroughs.playerId, filter.playerId));
    }

    const rows = await db
      .select({
        id: schema.playthroughs.id,
        scriptId: schema.playthroughs.scriptId,
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
            eq(schema.playthroughs.scriptId, input.scriptId),
            input.playerId
              ? eq(schema.playthroughs.playerId, input.playerId)
              : sql`${schema.playthroughs.playerId} IS NULL`,
          ),
        );
      const existing = Number(countResult[0]?.count ?? 0);
      title = `游玩 #${existing + 1}`;
    }

    const id = crypto.randomUUID();

    await db.insert(schema.playthroughs).values({
      id,
      playerId: input.playerId ?? null,
      scriptId: input.scriptId,
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
   */
  async getById(
    id: string,
    entriesLimit = 50,
    entriesOffset = 0,
  ): Promise<PlaythroughDetail | null> {
    const rows = await db
      .select()
      .from(schema.playthroughs)
      .where(eq(schema.playthroughs.id, id))
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
      scriptId: pt.scriptId,
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
      createdAt: pt.createdAt,
      updatedAt: pt.updatedAt,
      entries: entries as NarrativeEntryRow[],
      totalEntries,
      hasMore: entriesOffset + entries.length < totalEntries,
    };
  }

  /**
   * 更新游玩记录（改标题/归档）
   */
  async update(id: string, input: UpdateInput): Promise<boolean> {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.title !== undefined) patch.title = input.title;
    if (input.archived !== undefined) patch.archived = input.archived;

    const result = await db
      .update(schema.playthroughs)
      .set(patch)
      .where(eq(schema.playthroughs.id, id))
      .returning({ id: schema.playthroughs.id });

    return result.length > 0;
  }

  /**
   * 硬删除（narrative_entries 通过 CASCADE 自动删除）
   */
  async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.playthroughs)
      .where(eq(schema.playthroughs.id, id))
      .returning({ id: schema.playthroughs.id });

    return result.length > 0;
  }

  /**
   * 统计某剧本 + 某玩家的游玩数
   */
  async countByScriptAndPlayer(
    scriptId: string,
    playerId?: string | null,
  ): Promise<number> {
    const conditions = [eq(schema.playthroughs.scriptId, scriptId)];
    if (playerId) {
      conditions.push(eq(schema.playthroughs.playerId, playerId));
    } else {
      conditions.push(sql`${schema.playthroughs.playerId} IS NULL`);
    }

    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.playthroughs)
      .where(and(...conditions));

    return Number(result[0]?.count ?? 0);
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
    }>,
  ): Promise<void> {
    await db
      .update(schema.playthroughs)
      .set({ ...patch, updatedAt: new Date() })
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
    // 获取当前最大 orderIdx
    const maxResult = await db
      .select({ max: sql<number>`coalesce(max(${schema.narrativeEntries.orderIdx}), -1)` })
      .from(schema.narrativeEntries)
      .where(eq(schema.narrativeEntries.playthroughId, entry.playthroughId));
    const nextIdx = Number(maxResult[0]?.max ?? -1) + 1;

    const id = crypto.randomUUID();
    await db.insert(schema.narrativeEntries).values({
      id,
      playthroughId: entry.playthroughId,
      role: entry.role,
      content: entry.content,
      reasoning: entry.reasoning ?? null,
      toolCalls: entry.toolCalls ?? null,
      finishReason: entry.finishReason ?? null,
      orderIdx: nextIdx,
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
