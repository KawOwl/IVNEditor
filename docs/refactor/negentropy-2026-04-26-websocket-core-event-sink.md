# Negentropy Report: WebSocket CoreEvent Sink

Date: 2026-04-26

Branch: `codex/code-quality-refactor`

## Change Summary

- Replaced the server WebSocket sink's legacy `SessionEmitter` projection path
  with a direct CoreEvent interpreter.
- Preserved the existing WebSocket JSON message protocol for the UI.
- Deleted the server-only `ws-session-emitter.mts` legacy adapter.
- Added WebSocket tests for the existing message sequence and debug gating.

## Verification

```bash
cd apps/server && bun --env-file ../../.env test src/__tests__/ws-core-event-sink.test.mts
cd apps/server && bun --env-file ../../.env test
pnpm typecheck
pnpm check:esm
negentropy analyze . --format json --fail-on none --baseline docs/refactor/negentropy-json/negentropy-2026-04-26-persistence-core-event-sink.json --output docs/refactor/negentropy-json/negentropy-2026-04-26-websocket-core-event-sink.json
```

Results:

- WebSocket targeted tests: 2 pass, 0 fail
- Server tests: 183 pass, 0 fail
- Workspace typecheck: pass
- ESM check: pass
- Negentropy: exit 0 with `--fail-on none`

## Negentropy Summary

Source JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-websocket-core-event-sink.json`

Baseline JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-persistence-core-event-sink.json`

Summary:

- Tool version: `0.1.0`
- Files scanned: 222
- Modules: 222
- Overall risk: medium
- Medium dimensions: `logic_cohesion`, `state_encapsulation`

Delta:

- `module_abstraction`: `0.016` -> `0.017`; risk unchanged at low
- `logic_cohesion`: unchanged at medium
- `change_blast_radius`: unchanged at low
- `architecture_decoupling`: unchanged at low
- `testability_pluggability`: `0.866` -> `0.870`; risk unchanged at low
- `intent_redundancy`: unchanged at low
- `state_encapsulation`: unchanged at medium
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

The server runtime now sends WebSocket messages from CoreEvents directly:

```text
GameSession
  -> CoreEvent
  -> createWebSocketCoreEventSink
  -> existing JSON message protocol
  -> UI
```

The remaining legacy `SessionEmitter` projection is now limited to core tests,
recording/evaluation compatibility, and historical comparison paths.
