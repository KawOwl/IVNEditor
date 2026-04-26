CREATE TABLE "core_event_envelopes" (
	"id" text PRIMARY KEY NOT NULL,
	"playthrough_id" text NOT NULL,
	"schema_version" integer NOT NULL,
	"sequence" integer NOT NULL,
	"occurred_at" bigint NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uniq_core_event_envelope_sequence" UNIQUE("playthrough_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"playthrough_id" text,
	"q1" text NOT NULL,
	"q2" text NOT NULL,
	"q3" text NOT NULL,
	"q4" text NOT NULL,
	"q4_other" text,
	"q5" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key" text NOT NULL,
	"model" text NOT NULL,
	"max_output_tokens" integer DEFAULT 8192 NOT NULL,
	"thinking_enabled" boolean,
	"reasoning_effort" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playthroughs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"script_version_id" text NOT NULL,
	"llm_config_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"chapter_id" text NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"turn" integer DEFAULT 0 NOT NULL,
	"state_vars" jsonb,
	"memory_snapshot" jsonb,
	"current_scene" jsonb,
	"sentence_index" integer,
	"input_hint" text,
	"input_type" text DEFAULT 'freetext' NOT NULL,
	"choices" jsonb,
	"preview" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "script_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"script_id" text NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"original_name" text,
	"content_type" text,
	"size_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "script_assets_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
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
	"production_llm_config_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"username" text,
	"password_hash" text,
	"display_name" text,
	"role_id" text DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "core_event_envelopes" ADD CONSTRAINT "core_event_envelopes_playthrough_id_playthroughs_id_fk" FOREIGN KEY ("playthrough_id") REFERENCES "public"."playthroughs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_playthrough_id_playthroughs_id_fk" FOREIGN KEY ("playthrough_id") REFERENCES "public"."playthroughs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playthroughs" ADD CONSTRAINT "playthroughs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playthroughs" ADD CONSTRAINT "playthroughs_script_version_id_script_versions_id_fk" FOREIGN KEY ("script_version_id") REFERENCES "public"."script_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playthroughs" ADD CONSTRAINT "playthroughs_llm_config_id_llm_configs_id_fk" FOREIGN KEY ("llm_config_id") REFERENCES "public"."llm_configs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_assets" ADD CONSTRAINT "script_assets_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "script_versions" ADD CONSTRAINT "script_versions_script_id_scripts_id_fk" FOREIGN KEY ("script_id") REFERENCES "public"."scripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_production_llm_config_id_llm_configs_id_fk" FOREIGN KEY ("production_llm_config_id") REFERENCES "public"."llm_configs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_core_event_envelopes_playthrough_id" ON "core_event_envelopes" USING btree ("playthrough_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_user_id" ON "feedback" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_playthrough_id" ON "feedback" USING btree ("playthrough_id");--> statement-breakpoint
CREATE INDEX "idx_feedback_created_at" ON "feedback" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_playthroughs_user_id" ON "playthroughs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_playthroughs_script_version_id" ON "playthroughs" USING btree ("script_version_id");--> statement-breakpoint
CREATE INDEX "idx_playthroughs_kind_user" ON "playthroughs" USING btree ("kind","user_id");--> statement-breakpoint
CREATE INDEX "idx_playthroughs_updated_at" ON "playthroughs" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_playthroughs_llm_config_id" ON "playthroughs" USING btree ("llm_config_id");--> statement-breakpoint
CREATE INDEX "idx_script_assets_script" ON "script_assets" USING btree ("script_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_one_published_per_script" ON "script_versions" USING btree ("script_id") WHERE status = 'published';--> statement-breakpoint
CREATE INDEX "idx_script_versions_script" ON "script_versions" USING btree ("script_id","version_number");--> statement-breakpoint
CREATE INDEX "idx_scripts_author" ON "scripts" USING btree ("author_user_id");--> statement-breakpoint
CREATE INDEX "idx_user_sessions_user_id" ON "user_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_sessions_expires" ON "user_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_users_role" ON "users" USING btree ("role_id");