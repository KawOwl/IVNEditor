/**
 * ScriptService — 剧本身份（scripts 表）CRUD
 *
 * 只管理 scripts 表上"跨版本稳定的"元数据（label、description、作者）。
 * 剧本版本（manifest / draft / published / archived）在 ScriptVersionService。
 *
 * 权限模型：
 * - create / update / delete 都要求调用方传入 authorUserId，隔离不同作者
 * - 列表按 authorUserId 过滤（编剧看自己的剧本）
 * - published 状态列表（玩家首页）通过 ScriptVersionService.listPublishedScripts 走
 */

import { eq, sql, desc } from 'drizzle-orm';
import { db, schema } from '#server/db';

// ============================================================================
// Types
// ============================================================================

/** 创建参数 */
export interface CreateScriptInput {
  /** 可选：允许调用方指定 id（用于兼容旧的"编剧端生成 uuid → 发布"流程） */
  id?: string;
  /** 必填：作者用户 id */
  authorUserId: string;
  label: string;
  description?: string;
  /** v2.7：可选的 production 时使用的 LLM 配置 id */
  productionLlmConfigId?: string | null;
}

/** 更新参数 */
export interface UpdateScriptInput {
  label?: string;
  description?: string | null;
  productionLlmConfigId?: string | null;
}

/** 行记录 */
export interface ScriptRow {
  id: string;
  authorUserId: string;
  label: string;
  description: string | null;
  productionLlmConfigId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Service
// ============================================================================

export class ScriptService {
  /**
   * 创建剧本身份。id 可选——如果给定，用 INSERT ... ON CONFLICT
   * 更新 label/description（编剧重新发布同 id 剧本时复用）；否则生成新 uuid。
   */
  async create(input: CreateScriptInput): Promise<ScriptRow> {
    const id = input.id ?? crypto.randomUUID();
    const now = sql`NOW()`;

    // Upsert：如果 id 已存在，更新 label/description；否则插入。
    await db
      .insert(schema.scripts)
      .values({
        id,
        authorUserId: input.authorUserId,
        label: input.label,
        description: input.description ?? null,
        productionLlmConfigId: input.productionLlmConfigId ?? null,
        // createdAt/updatedAt 由 DB default 填充
      })
      .onConflictDoUpdate({
        target: schema.scripts.id,
        set: {
          label: input.label,
          description: input.description ?? null,
          ...(input.productionLlmConfigId !== undefined
            ? { productionLlmConfigId: input.productionLlmConfigId }
            : {}),
          updatedAt: now,
        },
      });

    const rows = await db
      .select()
      .from(schema.scripts)
      .where(eq(schema.scripts.id, id))
      .limit(1);

    if (rows.length === 0) {
      throw new Error(`[ScriptService.create] failed to fetch row after upsert: ${id}`);
    }
    return rows[0] as ScriptRow;
  }

  /**
   * 按 id 查。跨作者都能查到；权限检查由调用方做
   * （列表和删除接口会加 authorUserId 过滤）。
   */
  async getById(id: string): Promise<ScriptRow | null> {
    const rows = await db
      .select()
      .from(schema.scripts)
      .where(eq(schema.scripts.id, id))
      .limit(1);
    return (rows[0] as ScriptRow | undefined) ?? null;
  }

  /** 列出所有剧本（按 updatedAt desc）—— 当前所有 admin 都能看所有剧本 */
  async listAll(): Promise<ScriptRow[]> {
    const rows = await db
      .select()
      .from(schema.scripts)
      .orderBy(desc(schema.scripts.updatedAt));
    return rows as ScriptRow[];
  }

  /** 列出某作者的所有剧本（保留用于"按作者过滤"场景） */
  async listByAuthor(authorUserId: string): Promise<ScriptRow[]> {
    const rows = await db
      .select()
      .from(schema.scripts)
      .where(eq(schema.scripts.authorUserId, authorUserId))
      .orderBy(desc(schema.scripts.updatedAt));
    return rows as ScriptRow[];
  }

  /**
   * 更新剧本元数据（label/description）。
   *
   * 注意：本方法**不做 ownership 检查**，调用方（路由层）应该已经
   * 验证了请求者有权操作。当前所有 scripts 路由都是 admin-only +
   * 暂时放开 admin 互相操作权限，所以 service 层不再过滤 authorUserId。
   */
  async update(
    id: string,
    input: UpdateScriptInput,
  ): Promise<boolean> {
    const patch: Record<string, unknown> = { updatedAt: sql`NOW()` };
    if (input.label !== undefined) patch.label = input.label;
    if (input.description !== undefined) patch.description = input.description;
    if (input.productionLlmConfigId !== undefined) {
      patch.productionLlmConfigId = input.productionLlmConfigId;
    }

    const result = await db
      .update(schema.scripts)
      .set(patch)
      .where(eq(schema.scripts.id, id))
      .returning({ id: schema.scripts.id });

    return result.length > 0;
  }

  /**
   * 删除剧本（级联删除 script_versions 和相关 playthroughs）。
   *
   * 同 update：不做 ownership，由路由层把关。
   */
  async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.scripts)
      .where(eq(schema.scripts.id, id))
      .returning({ id: schema.scripts.id });

    return result.length > 0;
  }

  /**
   * 取剧本的 ownership（仍然保留：将来若需要按作者过滤的接口可以用）
   * 返回 authorUserId 或 null（不存在）
   */
  async getOwnerId(id: string): Promise<string | null> {
    const rows = await db
      .select({ authorUserId: schema.scripts.authorUserId })
      .from(schema.scripts)
      .where(eq(schema.scripts.id, id))
      .limit(1);
    return rows[0]?.authorUserId ?? null;
  }
}

// 单例导出
export const scriptService = new ScriptService();
