-- ANN.1: partial unique index on memory_deletion_annotations
--
-- 同一 (playthrough_id, memory_entry_id) 只允许一条 active（cancelled_at IS NULL）
-- 标注。撤销后（cancelled_at 非空）允许再次标记。
--
-- partial unique index — drizzle-kit schema 不支持 WHERE 子句，必须手写。
-- 跟 0001 拆开是为了 0001 完全保持 drizzle canonical SQL，本文件只做
-- 一件 drizzle 表达不了的事。
--
-- snapshot 不会反映这个 partial unique（drizzle 不知道 WHERE 子句的存在），
-- 这是预期 —— snapshot 是"drizzle 知道的 schema"，不是"DB 完整状态"。
-- partial unique 作为 DB invariant 但不在 schema diff 路径上。

CREATE UNIQUE INDEX "uniq_memory_deletion_active"
  ON "memory_deletion_annotations" ("playthrough_id", "memory_entry_id")
  WHERE "cancelled_at" IS NULL;
