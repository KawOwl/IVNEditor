-- 6.2b: 把 admin 账号合并进 users 表，用 roles 表管角色
--
-- 破坏性迁移：清空所有业务数据。原因：
--   1. 6.1/6.2 阶段 admin 走的是 HMAC token 自包含认证，users 表里没有
--      admin 行；我在 6.3 给 requireAdmin 加了个 hack upsert 了 id=username
--      的脏行（比如 id='kawowl'）。这些都要清掉。
--   2. scripts.author_user_id 指向这些脏 users 行。
--   3. seed 脚本会用 UUID 重建 admin，username 字段照旧但 id 不再是 username
--      字符串。

-- 先清数据（先清叶子节点再清 users）
TRUNCATE TABLE "narrative_entries";--> statement-breakpoint
TRUNCATE TABLE "playthroughs" CASCADE;--> statement-breakpoint
TRUNCATE TABLE "script_versions" CASCADE;--> statement-breakpoint
TRUNCATE TABLE "scripts" CASCADE;--> statement-breakpoint
TRUNCATE TABLE "user_sessions";--> statement-breakpoint
TRUNCATE TABLE "users" CASCADE;--> statement-breakpoint

-- 建 roles 表
CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

-- 默认两个角色
INSERT INTO "roles" ("id", "name", "description") VALUES
	('admin', '管理员', '完全访问权限，可创建/编辑/发布剧本'),
	('user', '普通用户', '匿名玩家、注册玩家的默认角色');
--> statement-breakpoint

-- 给 users 加 role_id FK（默认 'user'）
ALTER TABLE "users" ADD COLUMN "role_id" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_users_role" ON "users" USING btree ("role_id");
