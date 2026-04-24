/**
 * ScriptVersionService — 剧本版本（script_versions 表）CRUD + 状态机
 *
 * 核心职责：
 * - 创建 draft（带 content hash 去重）
 * - 发布 draft → published（同时原 published 转 archived）
 * - 删除 draft（不允许删 published/archived）
 * - 列出某剧本的所有版本
 * - 取某版本的完整 manifest
 * - 列出所有有 published 版本的剧本（玩家首页用）
 * - 取某剧本的当前 published 版本（playthrough 创建用）
 *
 * 硬约束：同一 script 同时只能有一个 status='published' 的版本
 * （DB 层面通过 partial unique index idx_one_published_per_script 保证）。
 */

import { createHash } from 'node:crypto';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db, schema } from '#internal/db';
import type { ScriptManifest } from '@ivn/core/types';

// ============================================================================
// Types
// ============================================================================

export type VersionStatus = 'draft' | 'published' | 'archived';

/** 行记录（与数据库对齐） */
export interface ScriptVersionRow {
  id: string;
  scriptId: string;
  versionNumber: number;
  label: string | null;
  status: VersionStatus;
  manifest: ScriptManifest;
  contentHash: string;
  note: string | null;
  createdAt: Date;
  publishedAt: Date | null;
  archivedAt: Date | null;
}

/** 列表项（去掉大字段 manifest，用于版本列表展示） */
export type ScriptVersionSummary = Omit<ScriptVersionRow, 'manifest'>;

/** 创建参数 */
export interface CreateVersionInput {
  scriptId: string;
  manifest: ScriptManifest;
  label?: string;
  note?: string;
  /** 默认 'draft'。只在兼容旧的"一次性发布"路径时用 'published' */
  status?: VersionStatus;
}

/** 创建结果：如果内容 hash 和上一个版本一致，返回已有版本；否则创建新版本 */
export interface CreateVersionResult {
  version: ScriptVersionRow;
  created: boolean;  // false = 复用已有（去重命中）
}

export interface PublishedCatalogEntry {
  scriptId: string;
  scriptLabel: string;
  scriptDescription: string | null;
  authorUserId: string;
  version: ScriptVersionRow;
}

interface PublishedCatalogRow {
  scriptId: string;
  scriptLabel: string;
  scriptDescription: string | null;
  authorUserId: string;
  versionId: string;
  versionNumber: number;
  versionLabel: string | null;
  status: string;
  manifest: ScriptManifest;
  contentHash: string;
  note: string | null;
  createdAt: Date;
  publishedAt: Date | null;
  archivedAt: Date | null;
}

// ============================================================================
// Helpers
// ============================================================================

/** 计算 manifest 的内容 hash，用于"无变化 save 不创建新版本"去重 */
export function hashManifest(manifest: ScriptManifest): string {
  const json = JSON.stringify(manifest);
  return createHash('sha256').update(json).digest('hex');
}

// ============================================================================
// Service
// ============================================================================

export class ScriptVersionService {
  /**
   * 创建新版本。
   *
   * 行为：
   *   - 计算 content hash
   *   - 查该 script 最新版本（任何 status），如果 hash 相同 → 复用（不创建新行）
   *   - 否则：分配下一个 version_number，插入新行
   *   - 如果 status='published'：把该 script 之前的所有 published 版本改为 archived
   *     （partial unique index 要求同时只能有一个 published）
   */
  async create(input: CreateVersionInput): Promise<CreateVersionResult> {
    const hash = hashManifest(input.manifest);

    // 去重检查：查该 script 最新版本（按 version_number desc）
    const latestRows = await db
      .select()
      .from(schema.scriptVersions)
      .where(eq(schema.scriptVersions.scriptId, input.scriptId))
      .orderBy(desc(schema.scriptVersions.versionNumber))
      .limit(1);

    const latest = latestRows[0] as ScriptVersionRow | undefined;
    if (latest && latest.contentHash === hash) {
      return { version: latest, created: false };
    }

    // 计算下一个 version_number
    const nextVersionNumber = latest ? latest.versionNumber + 1 : 1;

    const id = crypto.randomUUID();
    const status: VersionStatus = input.status ?? 'draft';

    // 如果要创建 published 版本，先把旧的 published 转 archived
    // 必须在 insert 前做，否则 partial unique index 会冲突
    if (status === 'published') {
      await db
        .update(schema.scriptVersions)
        .set({
          status: 'archived',
          archivedAt: sql`NOW()`,
        })
        .where(
          and(
            eq(schema.scriptVersions.scriptId, input.scriptId),
            eq(schema.scriptVersions.status, 'published'),
          ),
        );
    }

    await db.insert(schema.scriptVersions).values({
      id,
      scriptId: input.scriptId,
      versionNumber: nextVersionNumber,
      label: input.label ?? null,
      status,
      manifest: input.manifest,
      contentHash: hash,
      note: input.note ?? null,
      publishedAt: status === 'published' ? sql`NOW()` : null,
      archivedAt: null,
    });

    const created = await db
      .select()
      .from(schema.scriptVersions)
      .where(eq(schema.scriptVersions.id, id))
      .limit(1);

    return {
      version: created[0] as ScriptVersionRow,
      created: true,
    };
  }

  /** 按 id 取单个版本（含完整 manifest） */
  async getById(versionId: string): Promise<ScriptVersionRow | null> {
    const rows = await db
      .select()
      .from(schema.scriptVersions)
      .where(eq(schema.scriptVersions.id, versionId))
      .limit(1);
    return (rows[0] as ScriptVersionRow | undefined) ?? null;
  }

  /**
   * 取某剧本当前 published 版本（玩家游玩 / 首页展示用）
   * 没有 published 版本 → 返回 null
   */
  async getCurrentPublished(scriptId: string): Promise<ScriptVersionRow | null> {
    const rows = await db
      .select()
      .from(schema.scriptVersions)
      .where(
        and(
          eq(schema.scriptVersions.scriptId, scriptId),
          eq(schema.scriptVersions.status, 'published'),
        ),
      )
      .limit(1);
    return (rows[0] as ScriptVersionRow | undefined) ?? null;
  }

  /**
   * 列出某剧本所有版本（按 version_number desc）
   * 返回 summary（不含 manifest 大字段），前端展示版本列表用
   */
  async listByScript(scriptId: string): Promise<ScriptVersionSummary[]> {
    const rows = await db
      .select({
        id: schema.scriptVersions.id,
        scriptId: schema.scriptVersions.scriptId,
        versionNumber: schema.scriptVersions.versionNumber,
        label: schema.scriptVersions.label,
        status: schema.scriptVersions.status,
        contentHash: schema.scriptVersions.contentHash,
        note: schema.scriptVersions.note,
        createdAt: schema.scriptVersions.createdAt,
        publishedAt: schema.scriptVersions.publishedAt,
        archivedAt: schema.scriptVersions.archivedAt,
      })
      .from(schema.scriptVersions)
      .where(eq(schema.scriptVersions.scriptId, scriptId))
      .orderBy(desc(schema.scriptVersions.versionNumber));
    return rows as ScriptVersionSummary[];
  }

  /**
   * 发布一个现有的 draft 版本。
   *
   * 步骤：
   *   1. 查目标版本，确认它是 draft 状态（不允许发布 archived）
   *   2. 把该 script 现有的 published 版本改为 archived
   *   3. 把目标版本改为 published，填 publishedAt
   *
   * 返回 true = 成功；false = 目标不存在或不是 draft
   */
  async publish(versionId: string): Promise<boolean> {
    const target = await this.getById(versionId);
    if (!target) return false;
    if (target.status !== 'draft') return false;

    // 原子地在事务里做（避免 partial unique index 竞争）
    await db.transaction(async (tx) => {
      await tx
        .update(schema.scriptVersions)
        .set({
          status: 'archived',
          archivedAt: sql`NOW()`,
        })
        .where(
          and(
            eq(schema.scriptVersions.scriptId, target.scriptId),
            eq(schema.scriptVersions.status, 'published'),
          ),
        );

      await tx
        .update(schema.scriptVersions)
        .set({
          status: 'published',
          publishedAt: sql`NOW()`,
        })
        .where(eq(schema.scriptVersions.id, versionId));
    });

    return true;
  }

  /**
   * 删除 draft 版本。
   * - 只允许删 draft（published 和 archived 有玩家历史，必须保留）
   * - 如果有 playthroughs 引用此版本，禁止删除（返回 false）
   */
  async deleteDraft(versionId: string): Promise<{ ok: boolean; reason?: string }> {
    const target = await this.getById(versionId);
    if (!target) return { ok: false, reason: 'not_found' };
    if (target.status !== 'draft') {
      return { ok: false, reason: `cannot_delete_${target.status}` };
    }

    // 检查是否有 playthroughs 引用
    const refs = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.playthroughs)
      .where(eq(schema.playthroughs.scriptVersionId, versionId));
    const refCount = Number(refs[0]?.count ?? 0);
    if (refCount > 0) {
      return { ok: false, reason: 'has_playthroughs' };
    }

    await db
      .delete(schema.scriptVersions)
      .where(eq(schema.scriptVersions.id, versionId));

    return { ok: true };
  }

  /**
   * 列出所有有 published 版本的剧本 —— 玩家首页 catalog 用。
   * 返回每个 script 的基础信息 + 其 published 版本的 manifest（用于首页展示字段）。
   */
  async listPublishedCatalog(): Promise<PublishedCatalogEntry[]> {
    // JOIN scripts + script_versions WHERE status='published'
    const rows = await db
      .select({
        scriptId: schema.scripts.id,
        scriptLabel: schema.scripts.label,
        scriptDescription: schema.scripts.description,
        authorUserId: schema.scripts.authorUserId,
        versionId: schema.scriptVersions.id,
        versionNumber: schema.scriptVersions.versionNumber,
        versionLabel: schema.scriptVersions.label,
        status: schema.scriptVersions.status,
        manifest: schema.scriptVersions.manifest,
        contentHash: schema.scriptVersions.contentHash,
        note: schema.scriptVersions.note,
        createdAt: schema.scriptVersions.createdAt,
        publishedAt: schema.scriptVersions.publishedAt,
        archivedAt: schema.scriptVersions.archivedAt,
      })
      .from(schema.scriptVersions)
      .innerJoin(
        schema.scripts,
        eq(schema.scriptVersions.scriptId, schema.scripts.id),
      )
      .where(eq(schema.scriptVersions.status, 'published'))
      .orderBy(desc(schema.scriptVersions.publishedAt));

    return rows.map(toPublishedCatalogEntry);
  }
}

// 单例导出
export const scriptVersionService = new ScriptVersionService();

function toPublishedCatalogEntry({
  scriptId,
  scriptLabel,
  scriptDescription,
  authorUserId,
  versionId,
  versionNumber,
  versionLabel,
  status,
  manifest,
  contentHash,
  note,
  createdAt,
  publishedAt,
  archivedAt,
}: PublishedCatalogRow): PublishedCatalogEntry {
  return {
    scriptId,
    scriptLabel,
    scriptDescription,
    authorUserId,
    version: {
      id: versionId,
      scriptId,
      versionNumber,
      label: versionLabel,
      status: status as VersionStatus,
      manifest,
      contentHash,
      note,
      createdAt,
      publishedAt,
      archivedAt,
    },
  };
}
