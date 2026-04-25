# Negentropy Report - 2026-04-25 Agent Rules

Command:

```bash
cargo run --quiet --manifest-path /Users/kawowl/project/negentropy-labs/negentropy/Cargo.toml -- analyze . --format json --fail-on none --output /tmp/ivn-negentropy-agents-2026-04-25.json
```

Exit code: `0`

This pass adds shared Claude/Codex agent guidance only. The scan is recorded so
future agents have the same commit-time quality signal even for documentation
changes.

## Summary

- Tool version: `0.1.0`
- Files scanned: `177`
- Modules: `177`
- Overall risk: `High`
- Extensions: `.cjs`, `.js`, `.jsx`, `.mjs`, `.mts`, `.ts`, `.tsx`

## Dimensions

| Dimension | Metric | Raw | Risk |
| --- | --- | ---: | --- |
| module_abstraction | IIE | `0.011` | Low |
| logic_cohesion | EAD | `2.0` | Medium |
| change_blast_radius | TCR | `0.006` | Low |
| architecture_decoupling | TCE | `0.006` | Low |
| testability_pluggability | EDR | `0.86` | Low |
| intent_redundancy | PLME | `0.0` | Low |
| state_encapsulation | SSE+OA | `{"oa":0.042,"sse":1.714}` | High |

## Documentation Impact

- Added `AGENTS.md` as the shared Claude/Codex working agreement.
- Moved code style, parser/runtime style, side-effect boundaries, package
  boundaries, verification, negentropy, and commit discipline into the shared
  document.
- Updated `CLAUDE.md` so Claude reads `AGENTS.md` first and no longer carries a
  stale copy of package boundary or commit-discipline rules.
- Refreshed the old single-package technology note in `CLAUDE.md` to avoid
  conflicting with the monorepo layout.

## Current Top Hotspots

- `apps/ui/src/ui/editor/ScriptInfoPanel.tsx::anonymous@532`: high external attribute reads.
- `packages/core/src/narrative-parser-v2/state.mts::concatOutputs`: high external attribute reads.
- `apps/ui/src/ui/architect/ResultPreview.tsx::anonymous@166`: high external attribute reads.
- `packages/core/src/schemas.mts`: high interface-to-implementation ratio.
- `apps/server/src/db/schema.mts`: high interface-to-implementation ratio.
- `packages/core/src/architect/injection-rule-generator.mts`: high interface-to-implementation ratio.
- `apps/server/src/__tests__/playthrough-service.test.mts`: high mutable declaration expansion.
- `apps/server/src/__tests__/narrative-reader.test.mts`: high mutable declaration expansion.
- `packages/core/src/__tests__/narration-cut.test.mts`: high mutable declaration expansion.

## Repository Notes

- Keep `AGENTS.md` as the single source for agent style preferences. Agent-
  specific files should link to it instead of copying sections.
- The next code refactor target remains `ScriptInfoPanel.tsx` presenter
  extraction, not another documentation pass.
- Parser-v2 should continue to keep pure reducer logic separate from streaming
  adapter state; this is now documented as a shared agent rule.
- If Effect-TS or a similar effect system is introduced later, start at DB/LLM/
  tracing/S3 boundaries rather than parser internals.

## Verification

- `pnpm check:esm`
- `pnpm typecheck`
- `git diff --check`
