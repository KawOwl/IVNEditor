/**
 * Playthrough Routes — 游玩记录管理
 *
 * GET    /api/playthroughs              — 列出游玩记录（可按 scriptId 筛选）
 * POST   /api/playthroughs              — 创建新游玩
 * GET    /api/playthroughs/:id          — 获取游玩详情 + entries（分页）
 * PATCH  /api/playthroughs/:id          — 更新（改标题/归档）
 * DELETE /api/playthroughs/:id          — 删除
 */

import { Elysia } from 'elysia';
import { eq, and, desc, asc, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { scriptStore } from '../storage/script-store';

const DEFAULT_ENTRIES_LIMIT = 50;

export const playthroughRoutes = new Elysia({ prefix: '/api/playthroughs' })

  // ============================================================================
  // GET / — 列出游玩记录
  // ============================================================================

  .get('/', async ({ query }) => {
    const { scriptId, playerId } = query as { scriptId?: string; playerId?: string };

    const conditions = [eq(schema.playthroughs.archived, false)];
    if (scriptId) conditions.push(eq(schema.playthroughs.scriptId, scriptId));
    if (playerId) conditions.push(eq(schema.playthroughs.playerId, playerId));

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
      .where(and(...conditions))
      .orderBy(desc(schema.playthroughs.updatedAt))
      .limit(100);

    // 附加 scriptTitle（从 scriptStore 读取）
    const playthroughs = rows.map((row) => {
      const record = scriptStore.get(row.scriptId);
      return {
        ...row,
        scriptTitle: record?.manifest.title ?? row.scriptId,
      };
    });

    return { playthroughs };
  })

  // ============================================================================
  // POST / — 创建新游玩
  // ============================================================================

  .post('/', async ({ body }) => {
    const { scriptId, playerId, title } = body as {
      scriptId: string;
      playerId?: string;
      title?: string;
    };

    if (!scriptId) {
      return new Response(JSON.stringify({ error: 'Missing scriptId' }), { status: 400 });
    }

    const record = scriptStore.get(scriptId);
    if (!record) {
      return new Response(JSON.stringify({ error: 'Script not found' }), { status: 404 });
    }

    // 自动生成标题：计算该 script 的现有游玩数
    let autoTitle = title;
    if (!autoTitle) {
      const countResult = await db
        .select({ count: sql<number>`count(*)` })
        .from(schema.playthroughs)
        .where(
          and(
            eq(schema.playthroughs.scriptId, scriptId),
            playerId
              ? eq(schema.playthroughs.playerId, playerId)
              : sql`${schema.playthroughs.playerId} IS NULL`,
          ),
        );
      const existing = Number(countResult[0]?.count ?? 0);
      autoTitle = `游玩 #${existing + 1}`;
    }

    const id = crypto.randomUUID();
    const chapterId = record.manifest.chapters[0]?.id ?? 'ch1';

    await db.insert(schema.playthroughs).values({
      id,
      playerId: playerId ?? null,
      scriptId,
      title: autoTitle,
      chapterId,
      status: 'idle',
      turn: 0,
      stateVars: {},
      memoryEntries: [],
      memorySummaries: [],
    });

    return { id, title: autoTitle };
  })

  // ============================================================================
  // GET /:id — 游玩详情 + entries（分页）
  // ============================================================================

  .get('/:id', async ({ params, query }) => {
    const { id } = params;
    const limit = Number((query as any).limit) || DEFAULT_ENTRIES_LIMIT;
    const offset = Number((query as any).offset) || 0;

    const rows = await db
      .select()
      .from(schema.playthroughs)
      .where(eq(schema.playthroughs.id, id))
      .limit(1);

    if (rows.length === 0) {
      return new Response(JSON.stringify({ error: 'Playthrough not found' }), { status: 404 });
    }

    const pt = rows[0];

    // 查询 entries（分页，按 orderIdx 升序）
    const entries = await db
      .select()
      .from(schema.narrativeEntries)
      .where(eq(schema.narrativeEntries.playthroughId, id))
      .orderBy(asc(schema.narrativeEntries.orderIdx))
      .limit(limit)
      .offset(offset);

    // 总 entries 数
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
      inputHint: pt.inputHint,
      inputType: pt.inputType,
      choices: pt.choices,
      preview: pt.preview,
      createdAt: pt.createdAt,
      updatedAt: pt.updatedAt,
      entries,
      totalEntries,
      hasMore: offset + entries.length < totalEntries,
    };
  })

  // ============================================================================
  // PATCH /:id — 更新（改标题/归档）
  // ============================================================================

  .patch('/:id', async ({ params, body }) => {
    const { id } = params;
    const { title, archived } = body as { title?: string; archived?: boolean };

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (title !== undefined) patch.title = title;
    if (archived !== undefined) patch.archived = archived;

    const result = await db
      .update(schema.playthroughs)
      .set(patch)
      .where(eq(schema.playthroughs.id, id))
      .returning({ id: schema.playthroughs.id });

    if (result.length === 0) {
      return new Response(JSON.stringify({ error: 'Playthrough not found' }), { status: 404 });
    }

    return { ok: true };
  })

  // ============================================================================
  // DELETE /:id — 硬删除（narrative_entries 通过 CASCADE 自动删除）
  // ============================================================================

  .delete('/:id', async ({ params }) => {
    const { id } = params;

    const result = await db
      .delete(schema.playthroughs)
      .where(eq(schema.playthroughs.id, id))
      .returning({ id: schema.playthroughs.id });

    if (result.length === 0) {
      return new Response(JSON.stringify({ error: 'Playthrough not found' }), { status: 404 });
    }

    return { ok: true };
  });
