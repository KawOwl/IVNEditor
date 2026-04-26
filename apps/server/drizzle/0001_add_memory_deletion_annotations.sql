CREATE TABLE "memory_deletion_annotations" (
	"id" text PRIMARY KEY NOT NULL,
	"turn_memory_retrieval_id" text NOT NULL,
	"playthrough_id" text NOT NULL,
	"memory_entry_id" text NOT NULL,
	"memory_entry_snapshot" jsonb NOT NULL,
	"reason_code" text NOT NULL,
	"reason_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "turn_memory_retrievals" (
	"id" text PRIMARY KEY NOT NULL,
	"playthrough_id" text NOT NULL,
	"turn" integer NOT NULL,
	"batch_id" text,
	"source" text NOT NULL,
	"query" text DEFAULT '' NOT NULL,
	"entries" jsonb NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"meta" jsonb,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "memory_deletion_annotations" ADD CONSTRAINT "memory_deletion_annotations_turn_memory_retrieval_id_turn_memory_retrievals_id_fk" FOREIGN KEY ("turn_memory_retrieval_id") REFERENCES "public"."turn_memory_retrievals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_deletion_annotations" ADD CONSTRAINT "memory_deletion_annotations_playthrough_id_playthroughs_id_fk" FOREIGN KEY ("playthrough_id") REFERENCES "public"."playthroughs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turn_memory_retrievals" ADD CONSTRAINT "turn_memory_retrievals_playthrough_id_playthroughs_id_fk" FOREIGN KEY ("playthrough_id") REFERENCES "public"."playthroughs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_memory_deletion_annotations_playthrough_created" ON "memory_deletion_annotations" USING btree ("playthrough_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_memory_deletion_annotations_memory_entry_id" ON "memory_deletion_annotations" USING btree ("memory_entry_id");--> statement-breakpoint
CREATE INDEX "idx_turn_memory_retrievals_playthrough_turn" ON "turn_memory_retrievals" USING btree ("playthrough_id","turn");--> statement-breakpoint
CREATE INDEX "idx_turn_memory_retrievals_batch_id" ON "turn_memory_retrievals" USING btree ("playthrough_id","batch_id");