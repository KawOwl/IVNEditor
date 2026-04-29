/**
 * PlaythroughService — 游玩记录业务逻辑层
 *
 * 封装 playthrough 元数据和状态字段的数据库操作。
 * Route 层只负责 HTTP/参数处理，不直接访问 db/schema。
 */

import { eq, and, desc, sql, inArray, isNull } from 'drizzle-orm';
import { db, schema } from '#internal/db';
import { extractPlainText } from '@ivn/core/narrative-parser';

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

/** 列表项（用于列表展示） */
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

/** 详情 */
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
      // join scripts 过滤指向已软删剧本的 playthroughs：
      // 玩家"我的游玩"和编剧"试玩历史"列表都不展示孤儿条目，避免点进去 404。
      // DB 行仍在，admin 想看孤儿 SQL 直查或用 includeDeleted（暂未实现）。
      isNull(schema.scripts.deletedAt),
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
      .innerJoin(
        schema.scriptVersions,
        eq(schema.playthroughs.scriptVersionId, schema.scriptVersions.id),
      )
      .innerJoin(
        schema.scripts,
        eq(schema.scriptVersions.scriptId, schema.scripts.id),
      )
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(schema.playthroughs.updatedAt))
      .limit(100);

    if (rows.length === 0) return rows;

    const derived = await this.derivePreviewsFromCoreEvents(rows.map((r) => r.id));
    return rows.map((row) => ({
      ...row,
      preview: derived.get(row.id) ?? row.preview,
    }));
  }

  /**
   * 从 core_event_envelopes 派生 preview：每个 playthrough 取最新一条
   * `narrative-segment-finalized.entry.content`，跑 extractPlainText 现算。
   *
   * 这样跟游戏中渲染同源 —— 同一份 v2 parser 既给 DialogBox 出 sentence、
   * 也给存档列表出 preview，scratch 块 / 视觉子标签统一被剥掉，老 preview
   * column 里的污染数据不再回流到 UI。派生空字符串（无事件 / 全 scratch /
   * 完全无法解析）时不写入 map，调用方 fallback 到 DB column 的现有值。
   *
   * SQL 形态：内查 max(sequence) per playthroughId（限定 event.type =
   * narrative-segment-finalized），外层 self-join 拿事件 jsonb。list 接口
   * 本身有 limit 100 + 每 playthrough 一条命中行，扇出可控。
   */
  private async derivePreviewsFromCoreEvents(
    playthroughIds: string[],
  ): Promise<Map<string, string>> {
    if (playthroughIds.length === 0) return new Map();

    const latestSeq = db
      .select({
        playthroughId: schema.coreEventEnvelopes.playthroughId,
        seq: sql<number>`max(${schema.coreEventEnvelopes.sequence})`.as('seq'),
      })
      .from(schema.coreEventEnvelopes)
      .where(
        and(
          inArray(schema.coreEventEnvelopes.playthroughId, playthroughIds),
          sql`${schema.coreEventEnvelopes.event}->>'type' = 'narrative-segment-finalized'`,
        ),
      )
      .groupBy(schema.coreEventEnvelopes.playthroughId)
      .as('latest_seq');

    const events = await db
      .select({
        playthroughId: schema.coreEventEnvelopes.playthroughId,
        event: schema.coreEventEnvelopes.event,
      })
      .from(schema.coreEventEnvelopes)
      .innerJoin(
        latestSeq,
        and(
          eq(schema.coreEventEnvelopes.playthroughId, latestSeq.playthroughId),
          eq(schema.coreEventEnvelopes.sequence, latestSeq.seq),
        ),
      );

    const map = new Map<string, string>();
    for (const row of events) {
      const event = row.event;
      if (event.type !== 'narrative-segment-finalized') continue;
      const content = event.entry.content;
      if (!content) continue;
      const preview = extractPlainText(content)
        .slice(0, 80)
        .replace(/\n/g, ' ')
        .trim();
      if (preview.length > 0) {
        map.set(row.playthroughId, preview);
      }
    }
    return map;
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
      // 首次 insert 时不填 snapshot；具体 adapter 自行兜底空状态。
      memorySnapshot: null,
    });

    return { id, title };
  }

  /**
   * 获取游玩详情。
   * 必须传 userId，只返回该用户自己的记录。
   * 不归属当前用户 或 不存在 → 都返回 null（对外都是 404，避免信息泄漏）。
   */
  async getById(
    id: string,
    userId: string,
  ): Promise<PlaythroughDetail | null> {
    const rows = await db
      .select()
      .from(schema.playthroughs)
      .where(and(eq(schema.playthroughs.id, id), eq(schema.playthroughs.userId, userId)))
      .limit(1);

    if (rows.length === 0) return null;
    const pt = rows[0];

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

  /** 硬删除。必须传 userId；不属于该用户的记录直接视为不存在（返回 false）。 */
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

}

// 单例导出
export const playthroughService = new PlaythroughService();
