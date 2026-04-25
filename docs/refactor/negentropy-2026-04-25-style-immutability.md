# Negentropy Report - 2026-04-25 Style Immutability Pass

Command:

```bash
cargo run --quiet --manifest-path /Users/kawowl/project/negentropy-labs/negentropy/Cargo.toml -- analyze . --format json --fail-on none --output /tmp/ivn-negentropy-style-2026-04-25.json
```

Exit code: `0`

The scan completed with `--fail-on none` so this style-only pass could record the
current architectural signal without blocking on existing high-risk hotspots.

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

## Refactor Impact

- Replaced imperative file/document assembly in editor upload paths with
  `filter` / `map` / `Promise.all` pipelines.
- Reworked prompt preview section assembly to return fresh arrays instead of
  pushing into a shared `sections` buffer, and marked disabled sections with
  immutable object copies.
- Reworked context assembly setup for user sections, focus metadata, custom
  ordering, and fallback messages without mutating the produced message list.
- Converted playthrough query predicates and route version metadata into compact
  array / `Map` construction.
- Converted memory summaries, tool catalog markdown, state serialization,
  scene sprite upsert, retrieval query assembly, and version-diff output into
  clearer immutable projections.
- Left parser reducers, stream accumulators, budget trimming, DB writes, and
  tool-call stacks imperative where ordering or stateful side effects are the
  point of the code.

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

- `ScriptInfoPanel.tsx` and `ResultPreview.tsx` still have render-local derived
  projections that would benefit from named presenter helpers or small view
  models.
- `packages/core/src/narrative-parser-v2/state.mts::concatOutputs` is a useful
  next review target, but it should be treated carefully because parser state
  transitions may be clearer as explicit ordered operations.
- The schema-heavy hotspots are expected after the protocol/schema consolidation;
  the useful next step is not to split blindly, but to separate public contract
  exports from DB/storage-only definitions where ownership is currently mixed.
- Test files dominate SSE hotspots. Most are acceptable setup mutation, but
  shared fixture factories could reduce repeated mutable scaffolding in server
  persistence and reader tests.

## Verification

- `pnpm check:esm`
- `pnpm typecheck`
- `pnpm test:core`
- `bun --env-file ../../.env test` from `apps/server`
- `git diff --check`
