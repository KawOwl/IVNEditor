/**
 * Database Connection — Drizzle + pg 连接池
 *
 * 使用 pg Pool 管理连接，Drizzle 作为查询构建器。
 * 导出 db 实例供整个 server 使用。
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import * as schema from '#internal/db/schema';
import { getServerEnv } from '#internal/env';

const env = getServerEnv();
const databaseUrl = env.DATABASE_URL;

/**
 * SSL 配置决策：
 *
 * PG_SSL 环境变量 > URL 里的 sslmode 参数 > 默认关闭
 *
 * 原因：部分托管 RDS（如你当前用的 pgm-wz9699v11xdbyu0ajo）**没开 SSL 端口**，
 * 即使 URL 里写了 sslmode=require 也会被服务端拒绝
 * （报 "The server does not support SSL connections"）。
 *
 * 另一方面 pg-connection-string v2 起，URL 里的 sslmode=require 被解读为
 * verify-full，对阿里云 RDS 这类 CN 不匹配的证书会直接拒绝。
 *
 * 给出三种明确选项（按 PG_SSL env）：
 *   - 'off'  | 'false' | 'disable' → 不走 SSL（本地/内网开发）
 *   - 'require' → TLS 加密但不校验证书（托管 RDS 主流）
 *   - 'verify' → 完整校验（仅当你有权威签发的证书）
 *
 * 默认：URL 里有 sslmode=... 时按 require 语义，没有就 off。
 */
function resolveSslConfig(): Pool['options']['ssl'] | false {
  const explicit = env.PG_SSL;
  if (explicit === 'off' || explicit === 'false' || explicit === 'disable') return false;
  if (explicit === 'verify' || explicit === 'verify-ca' || explicit === 'verify-full') {
    return { rejectUnauthorized: true };
  }
  if (explicit === 'require' || explicit === 'prefer') return { rejectUnauthorized: false };
  // URL 里带 sslmode=require/verify-ca/verify-full/prefer 时默认加密但不严校验
  if (/sslmode=(require|verify-ca|verify-full|prefer)/.test(databaseUrl)) {
    return { rejectUnauthorized: false };
  }
  return false;
}

// 从 URL 里移除 sslmode 参数——ssl 走 pool.ssl 配置统一管理，避免冲突。
const cleanedUrl = databaseUrl.replace(/([?&])sslmode=\w+&?/g, (_m, p) => (p === '?' ? '?' : ''))
  .replace(/[?&]$/, '');

const pool = new Pool({
  connectionString: cleanedUrl,
  max: env.PG_POOL_MAX,
  idleTimeoutMillis: 30000,
  // 15s 覆盖跨 region 连接 + SSL 握手的 worst case。
  // 本地开发连接阿里云 RDS 需要这个放宽；生产同 VPC 时 5s 也够。
  connectionTimeoutMillis: env.PG_CONNECT_TIMEOUT_MS,
  ssl: resolveSslConfig(),
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
 * （server 启动目录应当是 apps/server/ 所以相对路径也可以，这里用绝对路径更稳）
 */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * 应用所有待执行的迁移（启动时自动调用）
 *
 * Drizzle 会：
 *   1. 创建 drizzle schema + __drizzle_migrations 表（若不存在）
 *   2. 读取 drizzle/meta/_journal.json 按 when 顺序加载所有迁移
 *   3. 对比 DB 中已应用的最后一条迁移的 created_at
 *   4. 仅执行 folderMillis > lastDbMigration.created_at 的迁移
 *
 * 当前仓库有意把历史迁移清空：现有远端数据库的业务 schema 和数据作为基线保留，
 * __drizzle_migrations 记录清空。后续所有新 schema 变更都从新的 Drizzle 迁移开始。
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
