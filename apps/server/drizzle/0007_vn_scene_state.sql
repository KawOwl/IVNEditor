-- 0007: playthroughs 增加 VN 场景状态字段（M3）
--
-- 背景：
--   引擎从 chat-like UI 迁移到 ADV/VN-like UI（Yuzusoft 风格）。
--   每轮 LLM 输出按 XML-lite 格式（<d> / <scene> / <spr/>）生成，
--   引擎解析后得到结构化 Sentence[] + SceneState。
--
--   SceneState 由 change_scene / change_sprite / clear_stage 工具演进，
--   需要持久化以支持断线重连后前端恢复视觉状态。
--
-- 字段：
--   current_scene  jsonb  当前场景快照 { background, sprites[] }
--   sentence_index int    玩家已推进到的句子索引（从 0 起，null = 未开始）
--
-- 兼容性：两个字段都是 nullable，老 playthrough 保持 null 不影响 chat UI。

ALTER TABLE "playthroughs" ADD COLUMN "current_scene" jsonb;
ALTER TABLE "playthroughs" ADD COLUMN "sentence_index" integer;
