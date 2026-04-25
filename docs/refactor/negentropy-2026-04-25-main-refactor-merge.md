# Negentropy Report - 2026-04-25 Main Refactor Merge

Command:

```bash
cargo run --manifest-path /Users/kawowl/project/negentropy-labs/negentropy/Cargo.toml -- analyze . --format table --fail-on none --top 10
```

Exit code: `0`

## Summary

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
| testability_pluggability | EDR | `0.857` | Low |
| intent_redundancy | PLME | `0.0` | Low |
| state_encapsulation | SSE+OA | `{"oa":0.041,"sse":1.682}` | High |

## Integration Notes

- Merged `codex/refactor` into `codex/main-refactor` while preserving the declarative visual IR work that landed on `main`.
- Moved the v2 narrative parser into `packages/core/src/narrative-parser-v2` and exposed it through `@ivn/core/narrative-parser-v2`.
- Kept the monorepo package boundary: runtime code now imports via workspace packages or `#internal/*`; ESM forbidden-item check passes.
- Moved `htmlparser2` to `@ivn/core`, which is the package that owns parser-v2.
- Threaded `protocolVersion`, parser manifest data, and visual white-list assets through editor manifest creation, server session setup, and `GameSession`.

## Current Top Hotspots

- `apps/ui/src/ui/editor/ScriptInfoPanel.tsx::anonymous@532`: high external attribute reads.
- `packages/core/src/narrative-parser-v2/state.mts::concatOutputs`: high external attribute reads.
- `apps/ui/src/ui/architect/ResultPreview.tsx::anonymous@166`: high external attribute reads.
- `apps/ui/src/ui/play/vn/DialogBox.tsx::renderBody`: high external attribute reads.
- `apps/ui/src/ui/play/vn/useDialogTypewriter.mts::useDialogTypewriter`: high external attribute reads.
- `packages/core/src/narrative-parser-v2/reducer.mts::mergeResult`: high external attribute reads.
- `packages/core/src/schemas.mts`: high interface-to-implementation ratio.
- `apps/server/src/db/schema.mts`: high interface-to-implementation ratio.
- `apps/server/src/__tests__/playthrough-service.test.mts`: high mutable declaration expansion.
- `packages/core/src/game-session.mts`: high mutable declaration expansion.

## Follow-up Opinions

- `ScriptInfoPanel` is now the clearest UI extraction target: split protocol settings, memory settings, and visual asset editors into separate panels or hooks.
- Parser-v2 is functionally isolated, but `state.mts` and `reducer.mts` show cohesion pressure; a small `outputs` helper module would reduce the new hotspot without changing behavior.
- `GameSession` is much better bounded than before, but it still owns parser selection, streaming, persistence, tracing, and receive orchestration. The next useful slice is an explicit narration stream runtime facade.

## Verification

- `pnpm check:esm`
- `pnpm typecheck`
- `pnpm test:core`
- `set -a; source /Users/kawowl/project/github.com/KawOwl/IVNEditor/.env; set +a; pnpm test:server`
- `git diff --check`
