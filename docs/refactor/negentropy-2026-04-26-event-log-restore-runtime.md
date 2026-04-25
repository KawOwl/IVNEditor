# Negentropy Report: Event Log Restore Runtime

Date: 2026-04-26

Branch: `codex/code-quality-refactor`

## Change Summary

- Added a CoreEvent restore reducer that folds event logs into a stable
  `GameSession.restore()` state.
- Added server-side `core_event_envelopes` persistence and wired the WebSocket
  session runtime to append CoreEvent envelopes with continuous sequence numbers.
- Updated session open/restore to prefer CoreEvent-derived status, turn, memory,
  scene, and input request state.
- Fixed receive persistence to clear `waiting-input` to `idle`, so a reload
  after player input but before the next generate start continues the game.
- Kept a narrative-entry fallback for historical playthroughs without CoreEvent
  logs.

## Verification

```bash
/Users/kawowl/.bun/bin/bun test packages/core/src/__tests__/core-event-log-restore.test.mts packages/core/src/__tests__/event-log-core-event-sink.test.mts
/Users/kawowl/.bun/bin/bun test apps/server/src/__tests__/session-restore-input-state.test.mts
/Users/kawowl/.bun/bin/bun --env-file=apps/server/.env.test test apps/server/src/__tests__/playthrough-persistence.test.mts
/Users/kawowl/.bun/bin/bunx --bun pnpm --filter @ivn/core test
/Users/kawowl/.bun/bin/bunx --bun pnpm typecheck
/Users/kawowl/.bun/bin/bunx --bun pnpm check:esm
negentropy analyze . --format json --fail-on none --baseline docs/refactor/negentropy-json/negentropy-2026-04-26-restore-input-state.json --output docs/refactor/negentropy-json/negentropy-2026-04-26-event-log-restore-runtime.json
```

Results:

- Core targeted tests: 8 pass, 0 fail
- Server restore-input tests: 6 pass, 0 fail
- Server persistence tests with `.env.test`: 24 pass, 0 fail
- Core package tests: 283 pass, 0 fail
- Workspace typecheck: pass
- ESM check: pass
- Negentropy: exit 0 with `--fail-on none`

## Negentropy Summary

Source JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-event-log-restore-runtime.json`

Baseline JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-restore-input-state.json`

Summary:

- Tool version: `0.1.0`
- Files scanned: 235
- Modules: 235
- Overall risk: medium
- Medium dimensions: `logic_cohesion`, `state_encapsulation`

Delta:

- `module_abstraction`: `0.014` -> `0.015`; risk unchanged at low
- `logic_cohesion`: unchanged at medium
- `change_blast_radius`: unchanged at low
- `architecture_decoupling`: unchanged at low
- `testability_pluggability`: `0.874` -> `0.875`; risk unchanged at low
- `intent_redundancy`: unchanged at low
- `state_encapsulation`: `oa` unchanged at `0.058`, `sse 1.527 -> 1.518`; risk unchanged at medium
- `new_hotspots`: none
- `resolved_hotspots`: none

## Restore Semantics

The reducer distinguishes replay for UI from replay for runtime:

- `waiting-input-started` restores as waiting with the recorded request.
- `player-input-recorded` restores as idle, so the runtime generates the next
  turn instead of asking for the already-consumed input again.
- `generate-turn-completed` without a following `waiting-input-started` is
  promoted to a waiting restore point using the recorded signal request, or a
  freetext fallback.
- An interrupted generate rolls back to the last stable checkpoint.
