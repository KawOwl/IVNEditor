/**
 * 迁移脚本：引入玩家身份体系（users + user_sessions）
 *
 * 适用场景：
 *   - 线上已有 playthroughs（含 player_id 列）+ narrative_entries
 *   - 需要升级到新 schema：users / user_sessions / playthroughs.user_id NOT NULL
 *
 * 执行方式（在 server 目录下）：
 *   bun run scripts/migrate-player-identity.ts
 *
 * 安全性：
 *   - 幂等：已执行过的步骤会被跳过
 *   - 破坏性：会清空所有 playthroughs（老数据 player_id IS NULL，无法保留）
 *   - 新 schema 下 playthroughs.user_id 是 NOT NULL + FK，旧数据无法兼容
 *
 * 如果线上已经是新 schema（比如之前跑过一次），脚本会跳过所有已有结构。
 */

import { db } from '../src/db';
import { sql } from 'drizzle-orm';

// ============================================================================
// Helpers
// ============================================================================

async function tableExists(name: string): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${name}
  `);
  return r.rows.length > 0;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
  `);
  return r.rows.length > 0;
}

async function columnNullable(table: string, column: string): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT is_nullable FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
  `);
  return (r.rows[0] as any)?.is_nullable === 'YES';
}

async function constraintExists(table: string, name: string): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = ${table} AND constraint_name = ${name}
  `);
  return r.rows.length > 0;
}

async function indexExists(name: string): Promise<boolean> {
  const r = await db.execute(sql`
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${name}
  `);
  return r.rows.length > 0;
}

// ============================================================================
// Migration Steps
// ============================================================================

async function migrate() {
  console.log('=== Player Identity Migration ===\n');

  // Step 0: 先确保基础表存在（新库场景）
  if (!(await tableExists('playthroughs'))) {
    console.log('[info] playthroughs 不存在，应当走 drizzle-kit push 从零建表');
    console.log('  cd server && DATABASE_URL=... bun drizzle-kit push');
    return;
  }

  // Step 1: 清空老数据（playthroughs + narrative_entries 由 CASCADE 级联删除）
  console.log('[1/7] 清空老 playthroughs / narrative_entries...');
  await db.execute(sql`DELETE FROM narrative_entries`);
  const ptDeleted = await db.execute(sql`DELETE FROM playthroughs`);
  console.log(`  ✓ 已清空（删除 ${(ptDeleted as any).rowCount ?? 0} 条 playthrough）`);

  // Step 2: playthroughs.player_id → user_id（若还叫 player_id）
  if (await columnExists('playthroughs', 'player_id')) {
    console.log('[2/7] 重命名 playthroughs.player_id → user_id...');
    await db.execute(sql`ALTER TABLE playthroughs RENAME COLUMN player_id TO user_id`);
    console.log('  ✓ 已重命名');
  } else if (await columnExists('playthroughs', 'user_id')) {
    console.log('[2/7] playthroughs.user_id 已存在，跳过');
  } else {
    throw new Error('playthroughs 表缺少 player_id 和 user_id 列，无法迁移');
  }

  // Step 3: 清理旧索引 idx_playthroughs_player_id
  if (await indexExists('idx_playthroughs_player_id')) {
    console.log('[3/7] 删除旧索引 idx_playthroughs_player_id...');
    await db.execute(sql`DROP INDEX idx_playthroughs_player_id`);
    console.log('  ✓ 已删除');
  } else {
    console.log('[3/7] 旧索引已不存在，跳过');
  }

  // Step 4: 创建 users 表
  if (!(await tableExists('users'))) {
    console.log('[4/7] 创建 users 表...');
    await db.execute(sql`
      CREATE TABLE users (
        id text PRIMARY KEY,
        username text UNIQUE,
        password_hash text,
        display_name text,
        created_at timestamptz DEFAULT now() NOT NULL,
        last_seen_at timestamptz DEFAULT now() NOT NULL
      )
    `);
    console.log('  ✓ 已创建');
  } else {
    console.log('[4/7] users 表已存在，跳过');
  }

  // Step 5: 创建 user_sessions 表
  if (!(await tableExists('user_sessions'))) {
    console.log('[5/7] 创建 user_sessions 表...');
    await db.execute(sql`
      CREATE TABLE user_sessions (
        id text PRIMARY KEY,
        user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at timestamptz DEFAULT now() NOT NULL,
        last_used_at timestamptz DEFAULT now() NOT NULL,
        expires_at timestamptz NOT NULL
      )
    `);
    await db.execute(sql`CREATE INDEX idx_user_sessions_user_id ON user_sessions(user_id)`);
    await db.execute(sql`CREATE INDEX idx_user_sessions_expires ON user_sessions(expires_at)`);
    console.log('  ✓ 已创建');
  } else {
    console.log('[5/7] user_sessions 表已存在，跳过');
  }

  // Step 6: playthroughs.user_id 设为 NOT NULL + 加 FK
  if (await columnNullable('playthroughs', 'user_id')) {
    console.log('[6/7] 设置 playthroughs.user_id NOT NULL...');
    await db.execute(sql`ALTER TABLE playthroughs ALTER COLUMN user_id SET NOT NULL`);
    console.log('  ✓ 已设置');
  } else {
    console.log('[6/7] playthroughs.user_id 已是 NOT NULL，跳过');
  }

  if (!(await constraintExists('playthroughs', 'fk_playthroughs_user'))
      && !(await constraintExists('playthroughs', 'playthroughs_user_id_users_id_fk'))) {
    console.log('  添加 FK playthroughs.user_id → users.id...');
    await db.execute(sql`
      ALTER TABLE playthroughs
      ADD CONSTRAINT fk_playthroughs_user
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    `);
    console.log('  ✓ 已添加');
  } else {
    console.log('  FK 已存在，跳过');
  }

  // Step 7: 新索引 idx_playthroughs_user_id
  if (!(await indexExists('idx_playthroughs_user_id'))) {
    console.log('[7/7] 创建索引 idx_playthroughs_user_id...');
    await db.execute(sql`CREATE INDEX idx_playthroughs_user_id ON playthroughs(user_id)`);
    console.log('  ✓ 已创建');
  } else {
    console.log('[7/7] 索引已存在，跳过');
  }

  console.log('\n=== 迁移完成 ===');
}

migrate()
  .then(() => {
    console.log('Success.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n迁移失败:', err);
    process.exit(1);
  });
