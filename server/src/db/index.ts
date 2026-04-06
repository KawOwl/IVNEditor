/**
 * Database Connection — Drizzle + pg 连接池
 *
 * 使用 pg Pool 管理连接，Drizzle 作为查询构建器。
 * 导出 db 实例供整个 server 使用。
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
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
