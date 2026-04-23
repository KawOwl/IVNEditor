-- 0011: narrative_entries 加 batch_id —— messages 数据模型重构（PR-M1）
--
-- 见 .claude/plans/messages-model.md
--
-- batch_id 语义：
--   同一 LLM step 产出的一批 entries 共享 UUID（narrative / signal_input /
--   tool_call 等同批写入的挂同一 batch_id）。玩家一次提交的 player_input
--   自己一个独立 UUID（未来多模态一次提交多 entry 场景，共享同一 batch）。
--
-- 视图层（messages-builder）按 batch_id 分组为"一次 LLM 响应 / 一次玩家提交"，
-- null 值走启发式兜底（player_input 作为 turn boundary）。
--
-- 向后兼容：
--   - batch_id nullable，0010 产出的老 entries 为 null，builder 兜底不坏
--   - 无需回填

ALTER TABLE "narrative_entries"
  ADD COLUMN "batch_id" text;

CREATE INDEX "idx_narrative_entries_batch_id"
  ON "narrative_entries" ("playthrough_id", "batch_id");
