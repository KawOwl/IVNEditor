# Negentropy Report - 2026-04-25 Main Agent Style Merge

Command:

```bash
cargo run --quiet --manifest-path /Users/kawowl/project/negentropy-labs/negentropy/Cargo.toml -- analyze . --format json --fail-on none --output /tmp/ivn-negentropy-main-merge-2026-04-25.json
```

Exit code: `0`

This scan was run after fast-forwarding local `main` to `origin/main`, resolving
the `CLAUDE.md` merge conflict, and integrating `codex/main-refactor`.

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

## Merge Notes

- Preserved the `origin/main` Claude Preview startup discipline.
- Preserved the new shared `AGENTS.md` Claude/Codex style and verification rules.
- Merged the immutable data assembly refactor into `main`.
- Merged the agent-rule documentation and both branch-level negentropy reports.
- Resolved the only conflict in `CLAUDE.md`; no code conflicts were present.

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

- `AGENTS.md` should remain the single source for shared agent style rules.
- `CLAUDE.md` should only keep Claude-specific workflow and operational notes.
- The next style-driven code target is still presenter/projection extraction in
  `ScriptInfoPanel.tsx` and `ResultPreview.tsx`.
- Parser-v2 remains a good example of pure reducer core plus imperative adapter
  shell; do not regress it into callback-heavy parser internals.

## Verification

- `pnpm check:esm`
- `pnpm typecheck`
- `pnpm test:core`
- `bun --env-file ../../.env test` from `apps/server`
- `git diff --check`
