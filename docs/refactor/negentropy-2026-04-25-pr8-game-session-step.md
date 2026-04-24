# Negentropy Report - 2026-04-25 PR8 Game Session Step

Command:

```bash
cargo run --quiet --manifest-path /Users/kawowl/project/negentropy-labs/negentropy/Cargo.toml -- analyze . --format both
```

Exit code: `2`

The scan completed and produced a report. The non-zero exit code reflects the
reported high overall risk.

## Summary

- Tool version: `0.1.0`
- Files scanned: `167`
- Modules: `167`
- Overall risk: `High`
- Extensions: `.cjs`, `.js`, `.jsx`, `.mjs`, `.mts`, `.ts`, `.tsx`

## Dimensions

| Dimension | Metric | Raw | Previous Raw | Risk |
| --- | --- | ---: | ---: | --- |
| module_abstraction | IIE | `0.008` | `0.008` | Low |
| logic_cohesion | EAD | `2.0` | `2.0` | Medium |
| change_blast_radius | TCR | `0.006` | `0.006` | Low |
| architecture_decoupling | TCE | `0.006` | `0.006` | Low |
| testability_pluggability | EDR | `0.849` | `0.851` | Low |
| intent_redundancy | PLME | `0.0` | `0.0` | Low |
| state_encapsulation | SSE+OA | `{"oa":0.043,"sse":1.69}` | `{"oa":0.044,"sse":1.69}` | High |

## Refactor Impact

- Split the `GameSession` `onStep` callback into named step lifecycle helpers:
  `handleStepStart`, `handleStepFinished`, and `rememberMainStepBatch`.
- Moved trace step payload projection into `toTraceStepRecord` with a declarative
  `TRACE_STEP_FIELDS` list.
- Kept the batch semantics unchanged: main steps update `currentStepBatchId`;
  follow-up steps are still traced but do not overwrite the main step batch.
- Removed `packages/core/src/game-session.mts::anonymous@712` from the current
  negentropy hotspot list without introducing a replacement core hotspot.
- `state_encapsulation` ownership ambiguity improved slightly from `0.044` to
  `0.043`; overall risk remains `High`.

## Current Top Hotspots

- `apps/ui/src/ui/App.tsx::publicInfoToManifest`: high external attribute reads.
- `apps/server/src/routes/mcp.mts::handler` at `add_background_to_script`: high external attribute reads.
- `apps/ui/src/stores/ws-message-handlers.mts::handleSessionMessage`: high external attribute reads.
- `packages/core/src/schemas.mts`: high interface-to-implementation ratio.
- `apps/server/src/db/schema.mts`: high interface-to-implementation ratio.
- `packages/core/src/architect/injection-rule-generator.mts`: high interface-to-implementation ratio.
- `apps/server/src/__tests__/playthrough-service.test.mts`: high mutable declaration expansion.
- `apps/server/src/__tests__/narrative-reader.test.mts`: high mutable declaration expansion.
- `packages/core/src/__tests__/narration-cut.test.mts`: high mutable declaration expansion.

## Verification

- `pnpm check`
- `pnpm typecheck:tsc`
- `pnpm test:core`
- `pnpm test:server`
- `pnpm build`
- `git diff --check`

## Follow-up Refactor Targets

- Split the surfaced `add_background_to_script` MCP handler into the same style
  of named command helpers used by `add_character_sprite`.
- Move `apps/ui/src/ui/App.tsx::publicInfoToManifest` into a dedicated UI adapter
  module or a specification-level projection if the shape is shared.
- Split `apps/ui/src/stores/ws-message-handlers.mts::handleSessionMessage` by
  message type once the current PR8 route/core sequence is complete.
