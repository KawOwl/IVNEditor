-- 0005: narrative_entries (playthroughId, orderIdx) 唯一约束
-- 防止并发 GameSession 写入导致 orderIdx 重复

-- 先清理可能存在的重复行（保留每组中 createdAt 最早的一行）
DELETE FROM "narrative_entries" a
  USING "narrative_entries" b
  WHERE a."playthrough_id" = b."playthrough_id"
    AND a."order_idx" = b."order_idx"
    AND a."created_at" > b."created_at";

ALTER TABLE "narrative_entries"
  ADD CONSTRAINT "uniq_narrative_entry_order"
  UNIQUE ("playthrough_id", "order_idx");
