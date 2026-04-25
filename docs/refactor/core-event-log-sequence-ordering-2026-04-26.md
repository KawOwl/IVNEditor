# CoreEvent Log Sequence Ordering

Date: 2026-04-26

Branch: `codex/code-quality-refactor`

## Why This Exists

Browser E2E found a restore/reconnect race that did not break the immediate
player UI, but could corrupt the durable CoreEvent log:

```text
duplicate key value violates unique constraint
"uniq_core_event_envelope_sequence"

Key (playthrough_id, sequence)=(..., 310) already exists.
```

The player-side save continued successfully: the restored choice was visible,
the player submitted input, and `narrative_entries` advanced. The broken part
was the durable CoreEvent history used by future restore/continue logic.

This note records the terms, the failure mode, and the invariant the server now
enforces.

## Glossary

`CoreEvent`

: A typed fact emitted by the engine. Examples:
  `session-restored`, `waiting-input-started`,
  `player-input-recorded`, `generate-turn-started`,
  `generate-turn-completed`.

`CoreEventEnvelope`

: A CoreEvent wrapped with storage metadata:
  `playthroughId`, `sequence`, `occurredAt`, and `schemaVersion`.

`core_event_envelopes`

: The database table that stores CoreEvent envelopes. It is the durable event
  log for one playthrough.

`sequence`

: The per-playthrough event order number. Restore folds events by ascending
  sequence, so `(playthroughId, sequence)` must be unique and gap-free enough to
  preserve ordering.

`sink`

: An output adapter for CoreEvents. The same event can be sent to multiple
  sinks:

```text
CoreEvent
  -> WebSocketCoreEventSink      live UI messages
  -> CoreEventLogSink            durable event log
  -> RecordingCoreEventSink      tests / harnesses
  -> SessionPersistence sink     narrative_entries / playthrough state
```

`durable`

: Persisted in the database and still available after reconnect, process
  restart, or deployment.

`initialSequence`

: The old server-side starting point for a new CoreEvent log sink. On WebSocket
  attach, the server read `max(sequence)` and created a sink that would write
  the next event as `max + 1`.

`pending append`

: A write that the old sink has already scheduled but that has not yet finished
  inserting into the database.

`advisory lock`

: A PostgreSQL application-level lock. We use a transaction-scoped lock keyed by
  `playthroughId`, so only CoreEvent writes for the same playthrough are
  serialized. Different playthroughs can still write concurrently.

## Failure Timeline

The race happened because `initialSequence` observed only rows already committed
to the database. It could not see writes still pending in an old WebSocket
sink.

```text
Database currently has max(sequence) = 309

Old WebSocket A
  prepares event with sequence 310
  append is pending, not committed yet

Browser reloads

New WebSocket B
  reads max(sequence) from DB
  DB still says 309
  B prepares event with sequence 310

A commits sequence 310
B tries to commit sequence 310

DB rejects B:
  duplicate (playthrough_id, sequence)
```

The confusing part: the UI could still look fine because session persistence and
WebSocket projection were not the failing write. The failure was isolated to
the durable CoreEvent log, which is exactly what future restore depends on.

## New Invariant

The server durable store is the source of truth for `sequence`.

The `sequence` attached by `createCoreEventLogSink` is still useful for
in-memory tests and generic replay helpers, but the server database writer does
not trust it. At insert time, the server allocates the next sequence inside a
database transaction.

Current server write shape:

```text
append(envelope)
  begin transaction
  acquire advisory lock for playthroughId
  read max(sequence) for playthroughId
  insert event with max + 1
  commit transaction and release lock
```

Concrete code:

- `apps/server/src/services/core-event-log.mts`

The lock key uses:

```sql
pg_advisory_xact_lock(hashtext(playthrough_id), 1)
```

The second lock component is `1` so this lock does not share the same namespace
as `narrative_entries.orderIdx` allocation, which uses component `0`.

## Fixed Timeline

```text
Database currently has max(sequence) = 309

Old WebSocket A wants to append
New WebSocket B wants to append

A enters transaction
A gets the playthrough lock
A reads max = 309
A writes sequence 310
A commits and releases lock

B enters transaction
B gets the playthrough lock
B reads max = 310
B writes sequence 311
B commits and releases lock
```

No caller-side stale state can reuse the same sequence number.

## Product Impact

This bug did not mean "read save is impossible." The E2E run showed the player
could restore, see choices, submit input, and continue.

It did mean:

- the durable CoreEvent log could silently stop being complete;
- future restore from CoreEvent log could become less reliable;
- the UI might pass today while the next reload/restore becomes harder to
  reason about.

That makes it a P0-adjacent correctness issue for the CoreEvent migration,
because CoreEvent log restore is supposed to become the preferred recovery path.

## Verification Performed

Browser E2E after the fix:

- player flow:
  - new production playthrough reached `waiting-input`;
  - browser reload returned to catalog;
  - playthrough list restored the save;
  - submitting the restored choice advanced DB turn `2 -> 3`;
  - `core_event_envelopes` advanced to `count=848`, `max_sequence=848`;
  - duplicate sequence query returned no rows.
- editor flow:
  - logged in as a temporary admin;
  - loaded `E2E 测试 · 图书馆奇遇`;
  - started a right-panel `试玩` playthrough;
  - returned to the playtest list and restored its choices.

Command verification:

```bash
/Users/kawowl/.bun/bin/bun test packages/core/src/__tests__/event-log-core-event-sink.test.mts packages/core/src/__tests__/core-event-log-restore.test.mts
/Users/kawowl/.bun/bin/bunx --bun pnpm typecheck
git diff --check
```

Negentropy report:

- `docs/refactor/negentropy-2026-04-26-core-event-log-sequence-allocation.md`
- `docs/refactor/negentropy-json/negentropy-2026-04-26-core-event-log-sequence-allocation.json`

## Design Rule Going Forward

Any durable, per-playthrough monotonic order allocated from `max(value) + 1`
must be protected by one of:

- a transaction-level advisory lock scoped to the playthrough;
- a dedicated database sequence/counter row;
- a single writer process with a durable queue.

For this codebase, advisory locks are currently the local pattern:

- `narrative_entries.orderIdx`: lock component `0`
- `core_event_envelopes.sequence`: lock component `1`
