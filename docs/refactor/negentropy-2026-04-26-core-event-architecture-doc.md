# Negentropy Report: CoreEvent Architecture Doc

Date: 2026-04-26

Branch: `codex/code-quality-refactor`

## Change Summary

- Added a current CoreEvent architecture status document.
- Tightened the WebSocket CoreEvent sink test into an exact golden message
  sequence.
- Documented completed CoreEvent work, remaining compatibility boundaries, and
  merge risk notes.

## Verification

```bash
cd apps/server && bun --env-file ../../.env test src/__tests__/ws-core-event-sink.test.mts
pnpm typecheck
pnpm check:esm
negentropy analyze . --format json --fail-on none --baseline docs/refactor/negentropy-json/negentropy-2026-04-26-core-event-log-sink.json --output docs/refactor/negentropy-json/negentropy-2026-04-26-core-event-architecture-doc.json
```

Results:

- WebSocket targeted tests: 2 pass, 0 fail
- Workspace typecheck: pass
- ESM check: pass
- Negentropy: exit 0 with `--fail-on none`

## Negentropy Summary

Source JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-core-event-architecture-doc.json`

Baseline JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-core-event-log-sink.json`

Summary:

- Tool version: `0.1.0`
- Files scanned: 224
- Modules: 224
- Overall risk: medium
- Medium dimensions: `logic_cohesion`, `state_encapsulation`

Delta:

- All dimensions unchanged
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

This report is intentionally paired with
`docs/refactor/core-event-architecture-2026-04-26.md`, which records the current
CoreEvent state after persistence, WebSocket, validator, and event-log work.
