# Negentropy Report - 2026-04-25 PR9 MCP Background Handler

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
| testability_pluggability | EDR | `0.848` | `0.849` | Low |
| intent_redundancy | PLME | `0.0` | `0.0` | Low |
| state_encapsulation | SSE+OA | `{"oa":0.043,"sse":1.707}` | `{"oa":0.043,"sse":1.69}` | High |

## Refactor Impact

- Split the MCP `add_background_to_script` anonymous handler into named helpers:
  argument parsing, background upsert, version note construction, result note
  construction, and the command handler.
- Kept the public MCP tool schema and response shape unchanged.
- Kept manifest mutation behavior unchanged: existing backgrounds preserve the
  previous label when no new label is provided.
- Removed `apps/server/src/routes/mcp.mts::handler` from the current negentropy
  hotspot list.
- Overall risk remains `High`. `state_encapsulation` SSE rose from `1.69` to
  `1.707`, likely because this local extraction adds several helper declarations
  in the same route module.

## Current Top Hotspots

- `apps/ui/src/ui/App.tsx::publicInfoToManifest`: high external attribute reads.
- `apps/ui/src/stores/ws-message-handlers.mts::handleSessionMessage`: high external attribute reads.
- `apps/ui/src/ui/architect/ResultPreview.tsx::anonymous@166`: high external attribute reads.
- `packages/core/src/schemas.mts`: high interface-to-implementation ratio.
- `apps/server/src/db/schema.mts`: high interface-to-implementation ratio.
- `packages/core/src/architect/injection-rule-generator.mts`: high interface-to-implementation ratio.
- `apps/server/src/__tests__/playthrough-service.test.mts`: high mutable declaration expansion.
- `apps/server/src/__tests__/narrative-reader.test.mts`: high mutable declaration expansion.
- `packages/core/src/__tests__/narration-cut.test.mts`: high mutable declaration expansion.

## Verification

- `pnpm check`
- `pnpm typecheck:tsc`
- `pnpm test:server`
- `pnpm build`
- `git diff --check`

## Follow-up Refactor Targets

- Continue PR9 with the planned UI projection extraction:
  `apps/ui/src/ui/App.tsx::publicInfoToManifest`.
- Split `apps/ui/src/stores/ws-message-handlers.mts::handleSessionMessage` by
  message type after the UI projection pass.
- Consider extracting repeated MCP manifest mutation helpers into a separate
  module if more route-level handlers are split in future rounds.
