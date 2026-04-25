# Negentropy Report: CoreEvent Log Sink

Date: 2026-04-26

Branch: `codex/code-quality-refactor`

## Change Summary

- Added `createCoreEventLogSink`, a durable CoreEvent sink that writes cloned
  `CoreEventEnvelope` records through an injected writer.
- Added `replayCoreEventEnvelopes` as the minimal replay foundation for
  envelope streams.
- Exported the event log sink and replay types from `@ivn/core/game-session`.
- Added tests for sequence numbering, envelope cloning, durable flush, and
  sequence-sorted replay.

## Verification

```bash
pnpm --filter @ivn/core test -- event-log-core-event-sink core-event-protocol
pnpm test:core
pnpm typecheck
pnpm check:esm
negentropy analyze . --format json --fail-on none --baseline docs/refactor/negentropy-json/negentropy-2026-04-26-core-event-protocol-validator.json --output docs/refactor/negentropy-json/negentropy-2026-04-26-core-event-log-sink.json
```

Results:

- Targeted core tests: 8 pass, 0 fail
- Full core tests: 274 pass, 0 fail
- Workspace typecheck: pass
- ESM check: pass
- Negentropy: exit 0 with `--fail-on none`

## Negentropy Summary

Source JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-core-event-log-sink.json`

Baseline JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-core-event-protocol-validator.json`

Summary:

- Tool version: `0.1.0`
- Files scanned: 224
- Modules: 224
- Overall risk: medium
- Medium dimensions: `logic_cohesion`, `state_encapsulation`

Delta:

- `module_abstraction`: `0.017` -> `0.015`; risk unchanged at low
- `logic_cohesion`: unchanged at medium
- `change_blast_radius`: unchanged at low
- `architecture_decoupling`: unchanged at low
- `testability_pluggability`: unchanged at low
- `intent_redundancy`: unchanged at low
- `state_encapsulation`: `sse 1.592` -> `1.558`; risk unchanged at medium
- `new_hotspots`: none
- `resolved_hotspots`: none

Top reported hotspots remain existing server/UI/schema/test areas:

- `apps/server/src/operations/script/add-character-sprite.mts::exec`
- `apps/server/src/operations/script/add-background.mts::exec`
- `apps/ui/src/ui/editor/ScriptInfoPanel.tsx::anonymous@532`
- `packages/core/src/schemas.mts`
- `apps/server/src/db/schema.mts`
- `packages/core/src/architect/injection-rule-generator.mts`

## Boundary Note

The event log boundary is intentionally capability-based:

```text
CoreEvent
  -> CoreEventLogSink
  -> CoreEventLogWriter.append(envelope)

CoreEventEnvelope[]
  -> replayCoreEventEnvelopes
  -> CoreEventSink
```

No database adapter is wired yet; this commit establishes the core contract and
ordering semantics.
