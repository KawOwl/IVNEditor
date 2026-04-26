# Negentropy Report: Remove Legacy Content Protocol

## Summary

- Removed the legacy narrative-entry content protocol and made CoreEvent history the only runtime content log.
- Replaced memory/readback projections with `core_event_envelopes`-based projections.
- Dropped obsolete historical protocol modules, server readers, fallback restore helpers, and tests.

## Command

```bash
negentropy analyze . --format json --fail-on none --baseline docs/refactor/negentropy-json/negentropy-2026-04-26-websocket-core-event-sink.json --output docs/refactor/negentropy-json/negentropy-2026-04-26-remove-legacy-content-protocol.json
```

## Result

- Overall risk: `medium`
- Files scanned: `224`
- Baseline: `docs/refactor/negentropy-json/negentropy-2026-04-26-websocket-core-event-sink.json`
- JSON report: `docs/refactor/negentropy-json/negentropy-2026-04-26-remove-legacy-content-protocol.json`

## Dimension Delta

- `module_abstraction` / IIE: `0.017 -> 0.027` (`low`)
- `logic_cohesion` / EAD: `2.0 -> 2.0` (`medium`)
- `change_blast_radius` / TCR: `0.0 -> 0.0` (`low`)
- `architecture_decoupling` / TCE: `0.0 -> 0.0` (`low`)
- `testability_pluggability` / EDR: `0.87 -> 0.885` (`low`)
- `intent_redundancy` / PLME: `0.0 -> 0.0` (`low`)
- `state_encapsulation` / SSE+OA: `sse 1.592 -> 1.404`, `oa 0.04 -> 0.051` (`medium`)

## Hotspot Delta

Resolved hotspots:

- `apps/server/src/__tests__/playthrough-service.test.mts`
- `apps/server/src/__tests__/narrative-reader.test.mts`
- `apps/server/scripts/migrate-player-identity.mts::migrate`
- `apps/ui/src/ui/editor/ScriptInfoPanel.tsx::anonymous@532`
- `packages/core/src/architect/injection-rule-generator.mts`

New hotspots:

- `packages/core/src/game-session/generate-turn-runtime.mts::drainNarrativeBatch`
- `packages/core/src/messages-builder.mts`
- `packages/core/src/__tests__/narration-pipeline.test.mts`
- `packages/core/src/game-session/core-event-history.mts`
- `apps/server/src/__tests__/app-smoke.test.mts::anonymous@22`

## Verification

- `pnpm check`: passed
- `env PATH=/Users/kawowl/.bun/bin:$PATH pnpm --filter @ivn/core test`: passed, `230` tests
- `env PATH=/Users/kawowl/.bun/bin:$PATH bun --env-file ../../.env test` from `apps/server`: attempted, blocked because this worktree has no `.env` / `apps/server/.env`, leaving `DATABASE_URL` undefined.
