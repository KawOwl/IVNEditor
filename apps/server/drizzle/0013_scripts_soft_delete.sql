-- 软删除 scripts。null = 活跃，非 null = 软删时刻。
-- 选软删而非硬删的原因：playthroughs.script_version_id FK 是 ON DELETE no action
-- （历史 migration 0002），硬删 script → cascade 删 script_versions → 撞 FK
-- violation 全 tx rollback。软删 sidestep 这条链 + 保留 trace + 误删可恢复。
ALTER TABLE "scripts" ADD COLUMN "deleted_at" timestamp with time zone;
