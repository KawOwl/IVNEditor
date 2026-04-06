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
	"player_id" text,
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
ALTER TABLE "narrative_entries" ADD CONSTRAINT "narrative_entries_playthrough_id_playthroughs_id_fk" FOREIGN KEY ("playthrough_id") REFERENCES "public"."playthroughs"("id") ON DELETE cascade ON UPDATE no action;