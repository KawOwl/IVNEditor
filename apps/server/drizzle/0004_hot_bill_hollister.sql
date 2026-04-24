-- v2.7: 多套 LLM 配置
--
-- 清空 playthroughs 是必须的：新加的 llm_config_id 列是 NOT NULL，
-- 老数据没有这个字段，直接 ALTER 会失败。为了让 migration 幂等，
-- 先 TRUNCATE narrative_entries + playthroughs。脚本层面本身是无损的，
-- 但用户的游玩进度会被清（和 6.1/6.2b 一致的破坏性迁移模式）。
TRUNCATE TABLE "narrative_entries";--> statement-breakpoint
TRUNCATE TABLE "playthroughs" CASCADE;--> statement-breakpoint

CREATE TABLE "llm_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key" text NOT NULL,
	"model" text NOT NULL,
	"thinking_enabled" boolean DEFAULT false NOT NULL,
	"reasoning_filter_enabled" boolean DEFAULT true NOT NULL,
	"max_output_tokens" integer DEFAULT 8192 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playthroughs" ADD COLUMN "llm_config_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "scripts" ADD COLUMN "production_llm_config_id" text;--> statement-breakpoint
ALTER TABLE "playthroughs" ADD CONSTRAINT "playthroughs_llm_config_id_llm_configs_id_fk" FOREIGN KEY ("llm_config_id") REFERENCES "public"."llm_configs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_production_llm_config_id_llm_configs_id_fk" FOREIGN KEY ("production_llm_config_id") REFERENCES "public"."llm_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_playthroughs_llm_config_id" ON "playthroughs" USING btree ("llm_config_id");