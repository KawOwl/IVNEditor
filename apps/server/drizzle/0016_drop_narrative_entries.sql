DELETE FROM "playthroughs" p
WHERE NOT EXISTS (
  SELECT 1
  FROM "core_event_envelopes" e
  WHERE e."playthrough_id" = p."id"
);
--> statement-breakpoint
DROP TABLE IF EXISTS "narrative_entries";
