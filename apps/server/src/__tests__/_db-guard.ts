/**
 * DB 测试安全锁
 *
 * 问题：apps/server/src/__tests__/ 里的 cleanTables() 对整张 users / scripts /
 * script_versions / llm_configs 等表做 db.delete()——相当于全表 TRUNCATE。
 * 如果 DATABASE_URL 指向的是共享的 dev/prod 库（比如 ivn_dev / ivn），每次
 * bun test 都会把线上数据洗一遍。踩过这个坑，数据凭空消失。
 *
 * 修法：所有测试文件的 cleanTables() 必须先调 assertTestDatabase()。
 * 只有 DB 名字里带 "test" / "_test" 的才允许执行破坏性操作。
 *
 * 怎么配测试 DB：
 *   1. 在你的 Postgres 里建一个 database 叫 `ivn_test`（SQL:
 *      `CREATE DATABASE ivn_test;`）。结构会由 drizzle migrate 自动建好。
 *   2. 跑测试时指定：
 *      DATABASE_URL="postgresql://.../ivn_test?sslmode=require" bun test
 *   3. 或 cp apps/server/.env apps/server/.env.test 改 DATABASE_URL，然后用
 *      `bun --env-file=.env.test test`。
 */

import { sql } from 'drizzle-orm';
import { db } from '../db';

/**
 * 只有 DB 名字里含 "test" 才放行（大小写不敏感）。
 * 否则抛错，阻止所有后续 DELETE。
 */
export async function assertTestDatabase(): Promise<void> {
  const r = await db.execute(sql`SELECT current_database() AS name`);
  const name = (r.rows[0] as { name?: string } | undefined)?.name;
  if (!name) {
    throw new Error('[test-db-guard] 拿不到 current_database()，为安全起见拒绝继续');
  }
  if (!/test/i.test(name)) {
    throw new Error(
      `\n\n[test-db-guard] 拒绝在非测试数据库上 cleanTables()\n` +
      `  当前 DB: "${name}"\n` +
      `  测试会 db.delete(schema.users/scripts/...) 全表清空。只有 DB 名字\n` +
      `  带 "test" 才放行（比如 ivn_test）。\n\n` +
      `  跑测试前：\n` +
      `    1. 在 Postgres 里 CREATE DATABASE ivn_test;\n` +
      `    2. DATABASE_URL="postgresql://.../ivn_test?..." bun test\n` +
      `       或者 cp apps/server/.env apps/server/.env.test 改指向 ivn_test，\n` +
      `       然后 bun --env-file=.env.test test\n\n`,
    );
  }
}
