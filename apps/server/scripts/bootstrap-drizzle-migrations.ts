/**
 * ⚠️ 已废弃 (DEPRECATED) — 一次性历史升级工具，已经在线上执行过了
 *
 * 全新环境不需要跑这个——直接 `bun run start` 就行：
 *   drizzle 会自动建 __drizzle_migrations 表 + 从 0000 baseline 全量建表。
 *
 * 保留原因：
 *   - 作为历史记录，万一还有老环境从"已有 schema 但没追踪"状态接入时参考
 *   - 也为 `drizzle-kit push` 使用者留一条升级到正规迁移流程的路径
 *
 * 什么时候可以彻底删除：确认不再需要把"已有 schema 标记为 baseline 已应用"。
 *
 * ─────────────────────────────────────────────────────────────
 * 以下为历史文档：
 * ─────────────────────────────────────────────────────────────
 *
 * bootstrap-drizzle-migrations — 首次启用 drizzle 迁移管理
 *
 * 适用场景（已结束）：
 *   DB 已经通过某种方式（drizzle-kit push / 手写 SQL / 一次性脚本）进入了
 *   和 drizzle/0000_xxx.sql baseline 相同的 schema 状态，但 __drizzle_migrations
 *   表不存在/是空的，需要告诉 drizzle "这些迁移已经应用过了"。
 *
 * 使用方式（在 server 目录下）:
 *   bun run scripts/bootstrap-drizzle-migrations.ts
 *
 * 安全性：
 *   - 幂等：__drizzle_migrations 已有记录时 pull-out，不做任何操作
 *   - 只能在"空表"状态下执行，防止误操作标记未运行的迁移
 *   - 完全使用 drizzle 自己的 readMigrationFiles，hash/folderMillis 由 drizzle 计算
 *     不手算也不反向工程
 *
 * 后续流程：
 *   1. 本地改 schema.ts
 *   2. bun run db:generate        → 生成 drizzle/0001_*.sql
 *   3. 提交 + 部署
 *   4. 服务器启动时 runMigrations() 自动应用新增的迁移
 */

import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { db, closePool } from '../src/db';

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

async function bootstrap() {
  console.log('=== Drizzle Migrations Bootstrap ===\n');

  // 1. 创建 drizzle schema 和 __drizzle_migrations 表（复制 drizzle 自己的 CREATE 语句）
  console.log('[1/3] 确保 drizzle schema 和 __drizzle_migrations 表存在...');
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
  console.log('  ✓');

  // 2. 安全检查：表必须为空，防止覆盖真实的迁移记录
  const countRes = await db.execute(
    sql`SELECT COUNT(*)::int AS c FROM "drizzle"."__drizzle_migrations"`,
  );
  const existing = Number((countRes.rows[0] as { c: number }).c);
  if (existing > 0) {
    console.log(`\n[skip] __drizzle_migrations 已有 ${existing} 条记录`);
    console.log('  bootstrap 只在"空表"时运行，防止覆盖真实的迁移历史');
    console.log('  后续的 schema 变更请走: bun run db:generate + 服务器启动时自动 migrate');
    console.log('  如果确认要重置: psql 里手动 DELETE FROM "drizzle"."__drizzle_migrations" 再重跑');
    return;
  }

  // 3. 用 drizzle 自己的 readMigrationFiles 读取所有迁移条目（hash + folderMillis 都是 drizzle 算好的）
  const migrations = readMigrationFiles({ migrationsFolder: MIGRATIONS_FOLDER });
  if (migrations.length === 0) {
    console.log('\n[skip] drizzle/ 下没有迁移文件');
    return;
  }

  console.log(`\n[2/3] 读到 ${migrations.length} 个迁移，全部标记为已应用（不执行 SQL 语句）:`);
  for (const m of migrations) {
    console.log(`  - hash=${m.hash.slice(0, 16)}... folderMillis=${m.folderMillis}`);
  }

  console.log('\n[3/3] 写入 __drizzle_migrations...');
  // 逐条 INSERT，用 drizzle 原本 migrate() 的 SQL 格式
  for (const m of migrations) {
    await db.execute(sql`
      INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at)
      VALUES (${m.hash}, ${m.folderMillis})
    `);
  }
  console.log('  ✓ 全部标记完成');

  console.log('\n=== 完成 ===');
  console.log('后续服务器启动会跳过已标记的迁移，只执行新增的 drizzle/*.sql');
}

bootstrap()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('\nbootstrap 失败:', err);
    await closePool().catch(() => {});
    process.exit(1);
  });
