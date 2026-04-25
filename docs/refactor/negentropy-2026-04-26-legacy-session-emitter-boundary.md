# Negentropy Report: Legacy SessionEmitter Boundary

Date: 2026-04-26

Branch: `codex/code-quality-refactor`

## Change Summary

- Added `@ivn/core/legacy-session-emitter` as the canonical public module for
  the legacy method-oriented emitter contract.
- Kept `@ivn/core/session-emitter` as a deprecated compatibility re-export.
- Moved the CoreEvent projection implementation to
  `game-session/legacy-session-emitter-projection`.
- Updated core tests, memory harness, and server WebSocket output to use
  `createLegacySessionEmitterProjection`.
- Removed the internal old-path projection shim after negentropy reported it as
  a new abstraction hotspot.

## Verification

```bash
pnpm --filter @ivn/core test -- session-emitter-projection.test.mts generate-turn-runtime.test.mts game-session-core-events.test.mts memory-evaluation-harness.test.mts core-event-protocol.test.mts
pnpm typecheck
pnpm check:esm
cd apps/server && bun --env-file ../../.env test src/__tests__/ws-core-event-sink.test.mts
negentropy analyze . --format json --fail-on none --baseline docs/refactor/negentropy-json/negentropy-2026-04-26-session-emitter-interface-removed.json --output docs/refactor/negentropy-json/negentropy-2026-04-26-legacy-session-emitter-boundary.json
```

Results:

- Targeted core tests: 11 pass, 0 fail
- Workspace typecheck: pass
- ESM check: pass
- Server WebSocket CoreEvent sink test: 1 pass, 0 fail
- Negentropy: exit 0 with `--fail-on none`

## Negentropy Summary

Source JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-legacy-session-emitter-boundary.json`

Baseline JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-session-emitter-interface-removed.json`

Summary:

- Tool version: `0.1.0`
- Files scanned: 220
- Modules: 220
- Overall risk: high
- High dimension: `state_encapsulation`
- Medium dimension: `logic_cohesion`

Delta:

- `module_abstraction`: unchanged
- `logic_cohesion`: unchanged
- `change_blast_radius`: unchanged
- `architecture_decoupling`: unchanged
- `testability_pluggability`: unchanged
- `intent_redundancy`: unchanged
- `state_encapsulation`: unchanged
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

This slice makes the compatibility boundary visible without changing WebSocket
message semantics:

```text
Core runtime
  -> CoreEventSink
  -> createLegacySessionEmitterProjection
  -> legacy SessionEmitter adapters
```

New core runtime code should depend on `CoreEventSink`. `SessionEmitter` remains
available only for legacy projection consumers and compatibility imports.
