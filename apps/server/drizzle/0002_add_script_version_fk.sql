-- 加 FK 约束之前，先清空 6.1 → 6.2 之间产生的过渡数据。
--
-- 背景：6.1 部署后 playthroughs.script_version_id 暂无 FK，老 routes 仍把
-- scriptStore key（如 'module-7'）写入这一列。线上有这种行存在的话，
-- 直接 ALTER TABLE 加 FK 会因为找不到对应的 script_versions 行而失败。
--
-- 既然 6.1 已经选择了"破坏性清空老数据"的迁移路径，6.2 沿用同样原则：
-- TRUNCATE 掉 6.1→6.2 之间产生的 transition 数据再加 FK。
TRUNCATE TABLE "narrative_entries";--> statement-breakpoint
TRUNCATE TABLE "playthroughs" CASCADE;--> statement-breakpoint

ALTER TABLE "playthroughs" ADD CONSTRAINT "playthroughs_script_version_id_script_versions_id_fk" FOREIGN KEY ("script_version_id") REFERENCES "public"."script_versions"("id") ON DELETE no action ON UPDATE no action;
