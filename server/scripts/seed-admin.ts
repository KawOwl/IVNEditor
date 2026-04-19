/**
 * Seed Admin — 创建或重置管理员账号
 *
 * 从环境变量 ADMIN_USERS 读入一份 "username:password" 列表，确保每条
 * 对应的 users 行存在、role_id='admin'、password_hash 是对应密码的 bcrypt
 * 哈希。
 *
 * 格式：分号分隔多个管理员，冒号分隔 username 和 password
 *   ADMIN_USERS="admin:<your-password>;editor:<your-password>"
 *
 * 行为：
 *   - username 已存在 → 更新 password_hash + 保证 role_id='admin'
 *   - username 不存在 → 创建新 users 行（随机 UUID 作为 id）+ role_id='admin'
 *
 * 运行：
 *   cd server && bun run scripts/seed-admin.ts
 * 或线上部署后：
 *   ADMIN_USERS=... bun run scripts/seed-admin.ts
 *
 * 说明：
 *   - 此脚本是幂等的，可以反复跑
 *   - 依赖 roles 表已经有 'admin' 行（migration 0003 建好的）
 *   - 修改/添加管理员时改 env 重跑即可，不需要改代码
 */

import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';

interface AdminEntry {
  username: string;
  password: string;
}

/** 解析 ADMIN_USERS env 变量 */
function parseAdminUsers(raw: string | undefined): AdminEntry[] {
  if (!raw) return [];
  return raw
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf(':');
      if (idx < 0) {
        throw new Error(`Invalid ADMIN_USERS entry (missing ":"): ${pair}`);
      }
      const username = pair.slice(0, idx).trim();
      const password = pair.slice(idx + 1).trim();
      if (!username || !password) {
        throw new Error(`Invalid ADMIN_USERS entry (empty field): ${pair}`);
      }
      return { username, password };
    });
}

async function upsertAdmin(entry: AdminEntry): Promise<{
  action: 'created' | 'updated';
  userId: string;
}> {
  const hash = await bcrypt.hash(entry.password, 10);

  // 检查是否已存在（按 username 查）
  const existing = await db
    .select({ id: schema.users.id, roleId: schema.users.roleId })
    .from(schema.users)
    .where(eq(schema.users.username, entry.username))
    .limit(1);

  if (existing.length > 0) {
    const row = existing[0]!;
    await db
      .update(schema.users)
      .set({
        passwordHash: hash,
        roleId: 'admin',
        displayName: entry.username,
      })
      .where(eq(schema.users.id, row.id));
    return { action: 'updated', userId: row.id };
  }

  // 新建：分配随机 UUID 作为稳定 id
  const newId = randomUUID();
  await db.insert(schema.users).values({
    id: newId,
    username: entry.username,
    passwordHash: hash,
    displayName: entry.username,
    roleId: 'admin',
  });
  return { action: 'created', userId: newId };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const raw = process.env.ADMIN_USERS;
  const admins = parseAdminUsers(raw);

  if (admins.length === 0) {
    console.log('[seed-admin] ADMIN_USERS env 为空，跳过');
    console.log('  示例: ADMIN_USERS="admin:<your-password>;editor:<your-password>"');
    process.exit(0);
  }

  console.log(`[seed-admin] 处理 ${admins.length} 个管理员...`);

  for (const entry of admins) {
    try {
      const result = await upsertAdmin(entry);
      console.log(`  ✓ ${entry.username} (${result.action}, id=${result.userId})`);
    } catch (err) {
      console.error(`  ✗ ${entry.username} 失败:`, err);
      process.exitCode = 1;
    }
  }

  console.log('[seed-admin] 完成');
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error('[seed-admin] 致命错误:', err);
  process.exit(1);
});
