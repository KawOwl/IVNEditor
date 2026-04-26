CREATE TABLE "user_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"affiliation" text NOT NULL,
	"gender" text NOT NULL,
	"grade" text NOT NULL,
	"major" text NOT NULL,
	"monthly_budget" text NOT NULL,
	"hobbies" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_unique" UNIQUE("email");