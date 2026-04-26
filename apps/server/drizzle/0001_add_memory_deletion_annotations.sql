-- ANN.1 Step 1: Memory deletion annotation tables
--
-- 见 docs/refactor/ann-1-memory-deletion-annotation-plan.md
--
-- 两张新表：
--   turn_memory_retrievals       —— 每次 Memory.retrieve 的结果落盘
--   memory_deletion_annotations  —— 用户标记"忘掉"某条 memory 的标注
--
-- 不改 playthroughs.memory_snapshot：tombstone 在 retrieve 边界做 filter，
-- 不进 snapshot（避开 6 个 adapter 的同步迁移）。
--
-- IF NOT EXISTS 兜底：dev DB 有可能因为之前的实验 / 残留已经存在这些表，
-- IF NOT EXISTS 让 migration 在那种 DB 上也能 no-op 通过。

CREATE TABLE IF NOT EXISTS "turn_memory_retrievals" (
  "id" text PRIMARY KEY NOT NULL,
  "playthrough_id" text NOT NULL,
  "turn" integer NOT NULL,
  -- 关联 batch_id（CoreEvent batchId）；context-assembly 早于 batch 分配时为 null
  "batch_id" text,
  -- 'context-assembly' / 'tool-call'
  "source" text NOT NULL,
  "query" text NOT NULL DEFAULT '',
  -- MemoryEntry[] 完整快照（含 stable id / role / content / pinned / tags）
  "entries" jsonb NOT NULL,
  -- adapter 返回的 summary 文本（mem0 / memorax 时是相关记忆 bullet list）
  "summary" text NOT NULL DEFAULT '',
  -- adapter meta（mem0 topK / scores / error 等）
  "meta" jsonb,
  "retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "turn_memory_retrievals_playthrough_id_fk"
    FOREIGN KEY ("playthrough_id") REFERENCES "playthroughs"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_turn_memory_retrievals_playthrough_turn"
  ON "turn_memory_retrievals" ("playthrough_id", "turn");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_turn_memory_retrievals_batch_id"
  ON "turn_memory_retrievals" ("playthrough_id", "batch_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "memory_deletion_annotations" (
  "id" text PRIMARY KEY NOT NULL,
  "turn_memory_retrieval_id" text NOT NULL,
  -- 冗余字段，便于按 playthrough 直接聚合查询
  "playthrough_id" text NOT NULL,
  "memory_entry_id" text NOT NULL,
  -- 删除时刻完整 MemoryEntry 内容（防止源条目漂移 / 被压缩 / 被淘汰）
  "memory_entry_snapshot" jsonb NOT NULL,
  -- 'character-broken' / 'memory-confused' / 'logic-error' / 'other'
  "reason_code" text NOT NULL,
  -- 仅 reason_code='other' 时填，玩家自由文本（短）
  "reason_text" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- 5s 撤销窗内取消填值；NULL 表示该标注 active
  "cancelled_at" timestamp with time zone,
  -- RESTRICT：retrieval 行不该被删；万一删了也不能把标注一起带走
  CONSTRAINT "memory_deletion_annotations_retrieval_fk"
    FOREIGN KEY ("turn_memory_retrieval_id")
    REFERENCES "turn_memory_retrievals"("id") ON DELETE RESTRICT,
  CONSTRAINT "memory_deletion_annotations_playthrough_fk"
    FOREIGN KEY ("playthrough_id") REFERENCES "playthroughs"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memory_deletion_annotations_playthrough_created"
  ON "memory_deletion_annotations" ("playthrough_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memory_deletion_annotations_memory_entry_id"
  ON "memory_deletion_annotations" ("memory_entry_id");
--> statement-breakpoint
-- 同一 (playthrough, memory_entry_id) 只允许一条 active 标注。
-- 撤销后（cancelled_at 非空）允许再次标记。
-- partial unique index — drizzle-kit schema 不支持 WHERE 子句，手写。
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_memory_deletion_active"
  ON "memory_deletion_annotations" ("playthrough_id", "memory_entry_id")
  WHERE "cancelled_at" IS NULL;
