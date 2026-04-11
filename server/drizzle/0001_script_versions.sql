-- 破坏性迁移：v2.6 剧本版本管理 schema 接入
-- playthroughs 新增 NOT NULL 列 script_version_id / kind，老数据无法满足约束，
-- 本项目明确选择"清空历史数据"的破坏性路径（PROGRESS.md v2.6 设计）。
-- 注意 script_version_id 暂无 FK 约束，6.2 完成 scripts/script_versions 路由
-- 后再补 FK。
TRUNCATE TABLE "narrative_entries";--> statement-breakpoint
TRUNCATE TABLE "playthroughs" CASCADE;--> statement-breakpoint

CREATE TABLE "script_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"script_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"label" text,
	"status" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	CONSTRAINT "uniq_script_version_number" UNIQUE("script_id","version_number")
);
--> statement-breakpoint
CREATE TABLE "scripts" (
	"id" text PRIMARY KEY NOT NULL,
	"author_user_id" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "idx_playthroughs_script_id";--> statement-breakpoint
ALTER TABLE "playthroughs" ADD COLUMN "script_version_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "playthroughs" ADD COLUMN "kind" text NOT NULL;--> statement-breakpoint
ALTER TABLE "script_versions" ADD CONSTRAINT "script_versions_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_one_published_per_script" ON "script_versions" USING btree ("script_id") WHERE status = 'published';--> statement-breakpoint
CREATE INDEX "idx_script_versions_script" ON "script_versions" USING btree ("script_id","version_number");--> statement-breakpoint
CREATE INDEX "idx_scripts_author" ON "scripts" USING btree ("author_user_id");--> statement-breakpoint
CREATE INDEX "idx_playthroughs_script_version_id" ON "playthroughs" USING btree ("script_version_id");--> statement-breakpoint
CREATE INDEX "idx_playthroughs_kind_user" ON "playthroughs" USING btree ("kind","user_id");--> statement-breakpoint
ALTER TABLE "playthroughs" DROP COLUMN "script_id";