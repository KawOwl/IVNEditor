# Negentropy Report - 2026-04-25 Main onStep Merge

Command:

```bash
negentropy analyze . --format json --fail-on none --output /tmp/ivn-negentropy-main-onstep-merge-2026-04-25.json
```

Exit code: `0`

The scan completed with `--fail-on none` while merging `origin/main` into the
CoreEvent / memory-evaluation refactor line. Existing high-risk hotspots remain
repository-wide and do not block this merge.

## Summary

- Tool version: `0.1.0`
- Files scanned: `209`
- Modules: `209`
- Overall risk: `High`
- Extensions: `.cjs`, `.js`, `.jsx`, `.mjs`, `.mts`, `.ts`, `.tsx`

## Dimensions

| Dimension | Metric | Raw | Risk |
| --- | --- | ---: | --- |
| module_abstraction | IIE | `0.018` | Low |
| logic_cohesion | EAD | `2.0` | Medium |
| change_blast_radius | TCR | `0.0` | Low |
| architecture_decoupling | TCE | `0.0` | Low |
| testability_pluggability | EDR | `0.857` | Low |
| intent_redundancy | PLME | `0.0` | Low |
| state_encapsulation | SSE+OA | `{"oa":0.037,"sse":1.63}` | High |

## Refactor Impact

- Merged `origin/main` through `2d11011`, including the DeepSeek V4
  tool-only-step replay fix.
- Ported the tool-only reasoning stub from the old monolithic `GameSession`
  location into `GenerateTurnRuntime`, where `currentReasoningBuffer` and
  step-scoped batch state now live.
- Kept `GameSession` as the generate/receive orchestration layer after the
  conflict resolution.

## Current Top Hotspots

- `apps/server/src/operations/script/add-character-sprite.mts::exec`: high
  external attribute reads.
- `apps/server/src/operations/script/add-background.mts::exec`: high external
  attribute reads.
- `apps/ui/src/ui/editor/ScriptInfoPanel.tsx::anonymous@532`: high external
  attribute reads.
- `packages/core/src/schemas.mts`: high interface-to-implementation ratio.
- `apps/server/src/db/schema.mts`: high interface-to-implementation ratio.
- `packages/core/src/architect/injection-rule-generator.mts`: high
  interface-to-implementation ratio.
- `apps/server/src/__tests__/playthrough-service.test.mts`: high mutable
  declaration expansion.
- `apps/server/src/__tests__/narrative-reader.test.mts`: high mutable
  declaration expansion.
- `packages/core/src/__tests__/narration-cut.test.mts`: high mutable declaration
  expansion.

## Verification

- `pnpm check:esm`
- `pnpm --filter @ivn/core test`
- `pnpm --filter @ivn/core typecheck`
- `pnpm typecheck`
- `git diff --check`
