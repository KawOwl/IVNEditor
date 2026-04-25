# Drizzle Migration Ordering Incident

Date: 2026-04-26

## What Happened

After `0013_scripts_soft_delete` reached staging, scripts appeared to vanish
from the UI. They were not actually soft-deleted. The server code had started
filtering script reads with `scripts.deleted_at IS NULL`, but the staging
database did not have the `deleted_at` column, so list queries failed.

The immediate staging repair was:

```sql
ALTER TABLE "scripts" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
```

## Root Cause

The project uses Drizzle's Postgres migrator at server startup. Drizzle reads
`drizzle/meta/_journal.json`, then compares each migration's `when` value
(`folderMillis`) with the latest `created_at` recorded in
`drizzle.__drizzle_migrations`.

It does not apply migrations by the filename number alone.

`0013_scripts_soft_delete` was merged with this ordering:

```text
0012_llm_thinking_control  when=1777842800000
0013_scripts_soft_delete   when=1777143934599
0014_core_event_envelopes  when=1777846400000
```

Any database that had already applied `0012` had a latest migration timestamp
greater than `0013`'s timestamp, so Drizzle skipped `0013` even though the file
number was higher. Fresh databases were less likely to hit this because an empty
migration table causes Drizzle to execute every migration in the journal.

## Repair Migration

`0015_repair_scripts_deleted_at` exists only to make this safe for every
environment:

```sql
ALTER TABLE "scripts" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;
```

It is intentionally idempotent. Environments already repaired manually keep
working, and environments that skipped `0013` get the missing column on the next
server startup.

## Rule Going Forward

- Do not edit already-pushed migration files to repair deployed environments.
- Add a new idempotent migration with a `when` value greater than every prior
  journal entry.
- Before merging migrations from another branch, check that `_journal.json`
  `when` values are monotonically increasing in journal order.
- A stale or mismatched row in `drizzle.__drizzle_migrations` is still dangerous,
  but the specific failure here can happen even without a stale row because the
  journal timestamp was out of order.
