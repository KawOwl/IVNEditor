CREATE TABLE "bug_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"playthrough_id" text,
	"turn" integer,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bug_reports" ADD CONSTRAINT "bug_reports_playthrough_id_playthroughs_id_fk" FOREIGN KEY ("playthrough_id") REFERENCES "public"."playthroughs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_bug_reports_user_id" ON "bug_reports" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_bug_reports_playthrough_id" ON "bug_reports" USING btree ("playthrough_id");--> statement-breakpoint
CREATE INDEX "idx_bug_reports_created_at" ON "bug_reports" USING btree ("created_at");