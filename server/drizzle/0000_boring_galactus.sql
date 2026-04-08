CREATE TABLE "narrative_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"playthrough_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"reasoning" text,
	"tool_calls" jsonb,
	"finish_reason" text,
	"order_idx" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playthroughs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"script_id" text NOT NULL,
	"title" text,
	"chapter_id" text NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"turn" integer DEFAULT 0 NOT NULL,
	"state_vars" jsonb,
	"memory_entries" jsonb,
	"memory_summaries" jsonb,
	"input_hint" text,
	"input_type" text DEFAULT 'freetext' NOT NULL,
	"choices" jsonb,
	"preview" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived" boolean DEFAULT false NOT NULL
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
ALTER TABLE "narrative_entries" ADD CONSTRAINT "narrative_entries_playthrough_id_playthroughs_id_fk" FOREIGN KEY ("playthrough_id") REFERENCES "public"."playthroughs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "playthroughs" ADD CONSTRAINT "playthroughs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_narrative_entries_playthrough_id" ON "narrative_entries" USING btree ("playthrough_id");--> statement-breakpoint
CREATE INDEX "idx_narrative_entries_order_idx" ON "narrative_entries" USING btree ("playthrough_id","order_idx");--> statement-breakpoint
CREATE INDEX "idx_playthroughs_user_id" ON "playthroughs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_playthroughs_script_id" ON "playthroughs" USING btree ("script_id");--> statement-breakpoint
CREATE INDEX "idx_playthroughs_updated_at" ON "playthroughs" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_user_sessions_user_id" ON "user_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_sessions_expires" ON "user_sessions" USING btree ("expires_at");