# Negentropy Report - 2026-04-25 GenerateTurnRuntime

Command:

```bash
negentropy analyze . --format json --fail-on none --output /tmp/ivn-negentropy-generate-turn-runtime-2026-04-25.json
```

Exit code: `0`

The scan completed with `--fail-on none` so this generate-turn refactor could
record architectural signal without blocking on existing repository-wide
hotspots.

## Summary

- Tool version: `0.1.0`
- Files scanned: `181`
- Modules: `181`
- Overall risk: `High`
- Extensions: `.cjs`, `.js`, `.jsx`, `.mjs`, `.mts`, `.ts`, `.tsx`

## Dimensions

| Dimension | Metric | Raw | Risk |
| --- | --- | ---: | --- |
| module_abstraction | IIE | `0.008` | Low |
| logic_cohesion | EAD | `2.0` | Medium |
| change_blast_radius | TCR | `0.0` | Low |
| architecture_decoupling | TCE | `0.0` | Low |
| testability_pluggability | EDR | `0.863` | Low |
| intent_redundancy | PLME | `0.0` | Low |
| state_encapsulation | SSE+OA | `{"oa":0.039,"sse":1.659}` | High |

## Refactor Impact

- Moved generate-phase orchestration and turn-scoped mutable state from
  `GameSession` into `GenerateTurnRuntime`.
- Reduced `GameSession` to session-level orchestration: start/restore/stop,
  begin generate, run generate phase, scenario finish check, and receive phase.
- Scoped `currentNarrativeBuffer`, `currentReasoningBuffer`,
  `currentStepBatchId`, parser runtime, scene patch emission, and abort handling
  to one generate turn.
- Added a deterministic runtime test with fake LLM, memory, persistence, and
  recording emitter so generate behavior can be verified without UI transport.
- Added a stopped-during-preparation check so an aborted turn does not open an
  empty streaming entry or call the LLM.
- Kept streaming parser and callback sequencing imperative where event order is
  the business rule.

## Current Top Hotspots

- `apps/ui/src/ui/editor/ScriptInfoPanel.tsx::anonymous@532`: high external
  attribute reads.
- `packages/core/src/narrative-parser-v2/state.mts::concatOutputs`: high
  external attribute reads.
- `apps/ui/src/ui/architect/ResultPreview.tsx::anonymous@166`: high external
  attribute reads.
- `packages/core/src/schemas.mts`: high interface-to-implementation ratio.
- `apps/server/src/db/schema.mts`: high interface-to-implementation ratio.
- `packages/core/src/architect/injection-rule-generator.mts`: high
  interface-to-implementation ratio.
- `apps/server/src/__tests__/playthrough-service.test.mts`: high mutable
  declaration expansion.
- `apps/server/src/__tests__/narrative-reader.test.mts`: high mutable
  declaration expansion.
- `packages/core/src/__tests__/narration-cut.test.mts`: high mutable
  declaration expansion.

## Repository Notes

- `GenerateTurnRuntime` is now the right place to continue refinement. If it
  grows further, split internally by responsibility: context preparation, LLM
  callback adapter, narrative runtime, and persistence completion.
- The state-encapsulation risk remains high mostly from mutable test setup and
  some long-lived runtime state, but this pass removed several generate-only
  fields from `GameSession`.
- The next evaluation-oriented step is a runner that wires
  `createRecordingSessionEmitter`, deterministic input scripts, and swappable
  memory configs into repeatable JSON reports.
- Parser v2 should remain a pure reducer plus small streaming adapter; avoid
  moving parser event-order code into generic collection pipelines just to look
  less imperative.

## Verification

- `pnpm check:esm`
- `pnpm typecheck`
- `pnpm test:core`
- `git diff --check`
