# Negentropy Report: Remove Legacy Runtime Branch

Date: 2026-04-26

Branch: `main`

## Change Summary

- Removed the unreachable V1 tool-driven narrative branch from
  `GenerateTurnRuntime`.
- Stopped exposing legacy visual tools (`change_scene`, `change_sprite`,
  `clear_stage`) to current runtime LLM calls.
- Kept historical V1 readback intact through `legacy-v1-readback`.
- Removed the dead `ChatMessage` type from `context-assembler`.
- Aligned editor and lint fallback protocol defaults with the current runtime
  protocol.

## Verification

```bash
bun test packages/core/src/__tests__/generate-turn-runtime.test.mts packages/core/src/__tests__/legacy-v1-readback.test.mts apps/server/src/operations/__tests__/lint-manifest.test.mts apps/ui/src/stores/__tests__/game-store-catchup.test.mts
pnpm typecheck
pnpm check:esm
pnpm test:core
git diff --check
negentropy analyze <clean mirror> --format json --fail-on none --baseline docs/refactor/negentropy-json/negentropy-2026-04-26-drizzle-migration-repair.json --output docs/refactor/negentropy-json/negentropy-2026-04-26-remove-legacy-runtime.json
```

Results:

- Targeted tests: pass, 38 tests.
- `pnpm typecheck`: pass.
- `pnpm check:esm`: pass.
- `pnpm test:core`: pass, 284 tests.
- `git diff --check`: pass.
- Negentropy: exit 0 with `--fail-on none`.

## Negentropy Summary

Source JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-remove-legacy-runtime.json`

Baseline JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-drizzle-migration-repair.json`

Summary:

- Tool version: `0.1.0`
- Files scanned: 235
- Modules: 235
- Overall risk: medium
- Medium dimensions: `logic_cohesion`, `state_encapsulation`

Delta:

- No risk-level changes.
- `state_encapsulation.sse`: `-0.018`
- `state_encapsulation.oa`: `+0.002`
- `new_hotspots`: none
- `resolved_hotspots`: none
