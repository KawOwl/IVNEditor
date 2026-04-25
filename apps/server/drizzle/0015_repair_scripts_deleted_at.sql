-- 0015: Repair scripts.deleted_at for environments that skipped 0013.
--
-- 0013_scripts_soft_delete was merged with a journal `when` timestamp older
-- than 0012_llm_thinking_control. Drizzle's Postgres migrator only compares
-- each migration's folderMillis against the latest DB migration created_at, so
-- environments that had already applied 0012 skipped 0013 even though its idx
-- was larger. Keep this idempotent because staging may have already been
-- repaired manually.

ALTER TABLE "scripts" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
