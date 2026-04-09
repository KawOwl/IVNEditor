/**
 * Database Connection — Drizzle + pg 连接池
 *
 * 使用 pg Pool 管理连接，Drizzle 作为查询构建器。
 * 导出 db 实例供整个 server 使用。
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { join } from 'path';
import * as schema from './schema';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,               // 最大连接数
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export const db = drizzle(pool, { schema });

// Re-export schema for convenience
export { schema };

/**
 * 测试数据库连接
 */
export async function testConnection(): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT 1');
    if (result.rows.length > 0) {
      console.log('[DB] PostgreSQL connected');
    }
  } finally {
    client.release();
  }
}

/**
 * 关闭连接池（graceful shutdown）
 */
export async function closePool(): Promise<void> {
  await pool.end();
  console.log('[DB] Connection pool closed');
}

/**
 * 迁移文件夹绝对路径
 * （server 启动目录应当是 server/ 所以相对路径也可以，这里用绝对路径更稳）
 */
const MIGRATIONS_FOLDER = join(import.meta.dir, '../../drizzle');

/**
 * 应用所有待执行的迁移（启动时自动调用）
 *
 * Drizzle 会：
 *   1. 创建 drizzle schema + __drizzle_migrations 表（若不存在）
 *   2. 读取 drizzle/meta/_journal.json 按 when 顺序加载所有迁移
 *   3. 对比 DB 中已应用的最后一条迁移的 created_at
 *   4. 仅执行 folderMillis > lastDbMigration.created_at 的迁移
 *
 * 所以对一个"已经是新 schema 但没记录过迁移"的环境（比如线上刚跑过
 * migrate-player-identity.ts），需要先跑 bootstrap-drizzle-migrations
 * 把 0000 baseline 标记为已应用，否则 migrate() 会尝试重复执行 CREATE TABLE。
 */
export async function runMigrations(): Promise<void> {
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    console.log('[DB] Migrations applied');
  } catch (err) {
    console.error('[DB] Migration failed:', err);
    throw err;
  }
}
