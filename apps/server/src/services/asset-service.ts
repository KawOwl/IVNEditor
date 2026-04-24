/**
 * AssetService — `script_assets` 表 CRUD（M4）
 *
 * 只管元数据；文件数据的 put/get 由 AssetStorage 处理。
 * 调用方典型流程：
 *   1. 生成 uuid + storage_key = `scripts/<scriptId>/<uuid><ext>`
 *   2. AssetStorage.put(storage_key, stream)
 *   3. AssetService.create({ scriptId, kind, storageKey, ... })
 *   4. 把 `/api/assets/<storageKey>` 返回给前端
 */

import { eq, and } from 'drizzle-orm';
import { db, schema } from '#server/db';

export type AssetKind = 'background' | 'sprite';

export interface AssetRow {
  id: string;
  scriptId: string;
  kind: AssetKind;
  storageKey: string;
  originalName: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  createdAt: Date;
}

export interface CreateAssetInput {
  id: string;
  scriptId: string;
  kind: AssetKind;
  storageKey: string;
  originalName?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
}

class AssetService {
  async create(input: CreateAssetInput): Promise<AssetRow> {
    await db.insert(schema.scriptAssets).values({
      id: input.id,
      scriptId: input.scriptId,
      kind: input.kind,
      storageKey: input.storageKey,
      originalName: input.originalName ?? null,
      contentType: input.contentType ?? null,
      sizeBytes: input.sizeBytes ?? null,
    });
    const rows = await db
      .select()
      .from(schema.scriptAssets)
      .where(eq(schema.scriptAssets.id, input.id))
      .limit(1);
    if (rows.length === 0) {
      throw new Error(`[asset-service.create] failed to fetch row after insert: ${input.id}`);
    }
    return rows[0] as AssetRow;
  }

  async getByKey(storageKey: string): Promise<AssetRow | null> {
    const rows = await db
      .select()
      .from(schema.scriptAssets)
      .where(eq(schema.scriptAssets.storageKey, storageKey))
      .limit(1);
    return (rows[0] as AssetRow) ?? null;
  }

  async listByScript(scriptId: string): Promise<AssetRow[]> {
    const rows = await db
      .select()
      .from(schema.scriptAssets)
      .where(eq(schema.scriptAssets.scriptId, scriptId));
    return rows as AssetRow[];
  }

  async delete(storageKey: string, scriptId: string): Promise<boolean> {
    const res = await db
      .delete(schema.scriptAssets)
      .where(
        and(
          eq(schema.scriptAssets.storageKey, storageKey),
          eq(schema.scriptAssets.scriptId, scriptId),
        ),
      );
    // pg result 的 rowCount 在 drizzle 里是 result 的属性；保守起见我们再查一次确认
    const still = await db
      .select({ id: schema.scriptAssets.id })
      .from(schema.scriptAssets)
      .where(eq(schema.scriptAssets.storageKey, storageKey))
      .limit(1);
    void res; // 未使用，保留给未来 debug
    return still.length === 0;
  }
}

export const assetService = new AssetService();
