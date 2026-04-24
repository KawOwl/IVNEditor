/**
 * LLMConfigService — 多套 LLM 配置的 CRUD
 *
 * 管理 llm_configs 表。admin 可以自由增删改；删除前要保证没有
 * playthroughs 引用（FK 是 ON DELETE RESTRICT）。
 *
 * API key 以明文存 text 列，GET 接口直接返回给 admin —— 和删掉的
 * /api/config/llm 保持一致的信任模型。
 */

import { eq, asc, sql } from 'drizzle-orm';
import { db, schema } from '../db';

// ============================================================================
// Types
// ============================================================================

export interface LlmConfigRow {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxOutputTokens: number;
  /** DeepSeek V4 thinking 模式开关；null = 不覆盖模型默认值 */
  thinkingEnabled: boolean | null;
  /** reasoning 强度 'high' | 'max' | null；null = 不传 */
  reasoningEffort: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateLlmConfigInput {
  name: string;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  maxOutputTokens?: number;
  thinkingEnabled?: boolean | null;
  reasoningEffort?: string | null;
}

export interface UpdateLlmConfigInput {
  name?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  maxOutputTokens?: number;
  thinkingEnabled?: boolean | null;
  reasoningEffort?: string | null;
}

export type DeleteResult =
  | { ok: true }
  | { ok: false; error: 'not-found' }
  | { ok: false; error: 'referenced-by-playthrough'; count: number };

const UPDATE_FIELDS = [
  'name',
  'provider',
  'baseUrl',
  'apiKey',
  'model',
  'maxOutputTokens',
  'thinkingEnabled',
  'reasoningEffort',
] satisfies ReadonlyArray<keyof UpdateLlmConfigInput>;

// ============================================================================
// Service
// ============================================================================

export class LlmConfigService {
  /** 按 createdAt 升序列出全部配置（admin 视图） */
  async listAll(): Promise<LlmConfigRow[]> {
    const rows = await db
      .select()
      .from(schema.llmConfigs)
      .orderBy(asc(schema.llmConfigs.createdAt));
    return rows as LlmConfigRow[];
  }

  async getById(id: string): Promise<LlmConfigRow | null> {
    const rows = await db
      .select()
      .from(schema.llmConfigs)
      .where(eq(schema.llmConfigs.id, id))
      .limit(1);
    return (rows[0] as LlmConfigRow | undefined) ?? null;
  }

  /** 用于 "fallback 到最早的 config" 逻辑 —— playthroughs POST 没带 llmConfigId 时用 */
  async getFirstConfig(): Promise<LlmConfigRow | null> {
    const rows = await db
      .select()
      .from(schema.llmConfigs)
      .orderBy(asc(schema.llmConfigs.createdAt))
      .limit(1);
    return (rows[0] as LlmConfigRow | undefined) ?? null;
  }

  async create(input: CreateLlmConfigInput): Promise<LlmConfigRow> {
    const id = crypto.randomUUID();
    await db.insert(schema.llmConfigs).values({
      id,
      name: input.name,
      provider: input.provider,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      model: input.model,
      maxOutputTokens: input.maxOutputTokens ?? 8192,
      thinkingEnabled: input.thinkingEnabled ?? null,
      reasoningEffort: input.reasoningEffort ?? null,
    });
    const row = await this.getById(id);
    if (!row) throw new Error(`[LlmConfigService.create] failed to fetch row after insert: ${id}`);
    return row;
  }

  async update(id: string, input: UpdateLlmConfigInput): Promise<boolean> {
    const result = await db
      .update(schema.llmConfigs)
      .set(buildUpdatePatch(input))
      .where(eq(schema.llmConfigs.id, id))
      .returning({ id: schema.llmConfigs.id });
    return result.length > 0;
  }

  /**
   * 删除配置。先检查反向引用：
   *   - playthroughs 引用 → 返回 referenced-by-playthrough + count，不删
   *   - scripts.production_llm_config_id 引用 → 会被 ON DELETE SET NULL 自动清空，不阻塞
   */
  async delete(id: string): Promise<DeleteResult> {
    // 检查 playthroughs 反向引用
    const refs = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.playthroughs)
      .where(eq(schema.playthroughs.llmConfigId, id));
    const count = refs[0]?.count ?? 0;
    if (count > 0) {
      return { ok: false, error: 'referenced-by-playthrough', count };
    }

    const result = await db
      .delete(schema.llmConfigs)
      .where(eq(schema.llmConfigs.id, id))
      .returning({ id: schema.llmConfigs.id });
    if (result.length === 0) return { ok: false, error: 'not-found' };
    return { ok: true };
  }
}

export const llmConfigService = new LlmConfigService();

function buildUpdatePatch(input: UpdateLlmConfigInput): Record<string, unknown> {
  const patch: Record<string, unknown> = { updatedAt: sql`NOW()` };

  for (const field of UPDATE_FIELDS) {
    const value = input[field];
    if (value !== undefined) {
      patch[field] = value;
    }
  }

  return patch;
}
