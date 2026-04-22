-- 0009: 合并 memory_entries + memory_summaries 为 memory_snapshot（记忆模块重构）
--
-- 记忆模块抽象重构 Phase 1 / Commit 4。
--
-- 旧格式：playthroughs 表两列
--   memory_entries JSONB    -- MemoryEntry[]
--   memory_summaries JSONB  -- string[]
--
-- 新格式：单列 opaque JSONB，由 Memory adapter 自己解释 kind
--   memory_snapshot JSONB   -- { kind: 'legacy-v1', entries: [...], summaries: [...] }
--
-- 这样未来切换到 mem0 adapter 时格式完全是 adapter 内部决定，DB schema 不用再迁。
-- 现有 playthrough 在 migration 里就地升级为 legacy-v1 格式，无感无损失。

-- Step 1: 加新列（可为 null，便于就地回填）
ALTER TABLE "playthroughs" ADD COLUMN "memory_snapshot" jsonb;

-- Step 2: 就地回填——把两列组合成 legacy-v1 opaque snapshot。
-- COALESCE 处理 NULL 行（早期 playthrough 可能 memoryEntries/memorySummaries 为空）。
UPDATE "playthroughs" SET "memory_snapshot" = jsonb_build_object(
  'kind', 'legacy-v1',
  'entries', COALESCE("memory_entries", '[]'::jsonb),
  'summaries', COALESCE("memory_summaries", '[]'::jsonb)
);

-- Step 3: 删旧两列（回填完成后不再需要）
ALTER TABLE "playthroughs" DROP COLUMN "memory_entries";
ALTER TABLE "playthroughs" DROP COLUMN "memory_summaries";
