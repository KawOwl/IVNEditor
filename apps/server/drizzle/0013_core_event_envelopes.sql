-- 0013: Persist CoreEvent envelopes per playthrough.
--
-- This table is append-only runtime history. It lets restore/open code derive
-- the precise continue point from CoreEvent data instead of trusting only the
-- coarse playthroughs.status row, which can be stale in the tiny window between
-- player_input persistence and the next generate start.

CREATE TABLE IF NOT EXISTS "core_event_envelopes" (
  "id" text PRIMARY KEY NOT NULL,
  "playthrough_id" text NOT NULL,
  "schema_version" integer NOT NULL,
  "sequence" integer NOT NULL,
  "occurred_at" bigint NOT NULL,
  "event" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "core_event_envelopes_playthrough_id_playthroughs_id_fk"
    FOREIGN KEY ("playthrough_id") REFERENCES "playthroughs"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "idx_core_event_envelopes_playthrough_id"
  ON "core_event_envelopes" ("playthrough_id");

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_core_event_envelope_sequence"
  ON "core_event_envelopes" ("playthrough_id", "sequence");
