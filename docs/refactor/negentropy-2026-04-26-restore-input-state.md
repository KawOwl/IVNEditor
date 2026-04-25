# Negentropy Report: Restore Input State

Date: 2026-04-26

Branch: `codex/code-quality-refactor`

## Change Summary

- Added server-side readback recovery for waiting-input choice state when older
  playthrough rows lack `inputType='choice'` / `choices`, using the latest
  unconsumed `signal_input` narrative entry.
- Updated the UI input panel visibility rule so restored sessions with no
  displayable readback sentence still expose waiting-input hints and choices.
- Added focused tests for both the server input-state recovery and UI visibility
  guard.

## Verification

```bash
/Users/kawowl/.bun/bin/bun test apps/ui/src/ui/__tests__/input-panel-visibility.test.mts
/Users/kawowl/.bun/bin/bun test apps/server/src/__tests__/session-restore-input-state.test.mts
/Users/kawowl/.bun/bin/bunx --bun pnpm --filter @ivn/ui typecheck
/Users/kawowl/.bun/bin/bunx --bun pnpm --filter @ivn/server typecheck
/Users/kawowl/.bun/bin/bunx --bun pnpm --filter @ivn/core typecheck
/Users/kawowl/.bun/bin/bunx --bun pnpm check:esm
/Users/kawowl/.bun/bin/bunx --bun pnpm typecheck
negentropy analyze . --format json --fail-on none --baseline docs/refactor/negentropy-json/negentropy-2026-04-26-websocket-core-event-sink.json --output docs/refactor/negentropy-json/negentropy-2026-04-26-restore-input-state.json
```

Results:

- UI targeted tests: 4 pass, 0 fail
- Server targeted tests: 4 pass, 0 fail
- Workspace typecheck: pass
- ESM check: pass
- Negentropy: exit 0 with `--fail-on none`

## Negentropy Summary

Source JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-restore-input-state.json`

Baseline JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-websocket-core-event-sink.json`

Summary:

- Tool version: `0.1.0`
- Files scanned: 232
- Modules: 232
- Overall risk: medium
- Medium dimensions: `logic_cohesion`, `state_encapsulation`

Delta:

- `module_abstraction`: `0.017` -> `0.014`; risk unchanged at low
- `logic_cohesion`: unchanged at medium
- `change_blast_radius`: unchanged at low
- `architecture_decoupling`: unchanged at low
- `testability_pluggability`: `0.870` -> `0.874`; risk unchanged at low
- `intent_redundancy`: unchanged at low
- `state_encapsulation`: `oa 0.040 -> 0.058`, `sse 1.592 -> 1.527`; risk unchanged at medium
- `new_hotspots`: none
- `resolved_hotspots`: none

Top reported hotspots remain existing server/UI/schema/test areas:

- `apps/server/src/operations/script/add-character-sprite.mts::exec`
- `apps/server/src/operations/script/add-background.mts::exec`
- `apps/ui/src/ui/editor/ScriptInfoPanel.tsx::anonymous@532`
- `packages/core/src/schemas.mts`
- `apps/server/src/db/schema.mts`
- `packages/core/src/architect/injection-rule-generator.mts`
