# Negentropy Report - 2026-04-25 Core Loop Evaluation Port

Command:

```bash
cargo run --quiet --manifest-path /Users/kawowl/project/negentropy-labs/negentropy/Cargo.toml -- analyze . --format json --fail-on none --output /tmp/ivn-negentropy-coreloop-eval-2026-04-25.json
```

Exit code: `0`

The scan completed with `--fail-on none` so this architecture slice could record
the current repository signal without blocking on existing high-risk hotspots.

## Summary

- Tool version: `0.1.0`
- Files scanned: `179`
- Modules: `179`
- Overall risk: `High`
- Extensions: `.cjs`, `.js`, `.jsx`, `.mjs`, `.mts`, `.ts`, `.tsx`

## Dimensions

| Dimension | Metric | Raw | Risk |
| --- | --- | ---: | --- |
| module_abstraction | IIE | `0.008` | Low |
| logic_cohesion | EAD | `2.0` | Medium |
| change_blast_radius | TCR | `0.006` | Low |
| architecture_decoupling | TCE | `0.006` | Low |
| testability_pluggability | EDR | `0.861` | Low |
| intent_redundancy | PLME | `0.0` | Low |
| state_encapsulation | SSE+OA | `{"oa":0.039,"sse":1.698}` | High |

## Refactor Impact

- Reframed `SessionEmitter` as a GameSession output port instead of a frontend
  view interface.
- Added `createRecordingSessionEmitter` so tests and future memory-evaluation
  jobs can consume core loop output without WebSocket, Zustand, or DOM.
- Extracted the parser/output side of `coreLoop` into narrative runtime helpers,
  keeping stream ordering explicit while moving parser details down a level.
- Extracted receive-phase waiting and persistence into `runReceivePhase`, making
  the top-level loop easier to read as generate-then-receive orchestration.
- Added focused tests for the recording consumer and documented the longer
  evaluation architecture direction.

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

- The next useful core-loop slice is generate-turn preparation/completion, not a
  parser rewrite. Parser v2 already has the desired pure reducer plus streaming
  adapter shape.
- `SessionEmitter` is now usable for evaluation, but its method-oriented API is
  still a transitional port. A future event ADT or `CoreLoopOutputPort` name
  would make ownership clearer once WebSocket and recording consumers settle.
- The current high SSE signal is mostly test fixture mutation. That is less
  urgent than isolating `GameSession` state ownership (`currentTurn`,
  `currentStepBatchId`, streaming buffers) behind smaller turn-runtime objects.
- An evaluation harness should import `createRecordingSessionEmitter` and
  compare recorded `Sentence`, `sceneChanges`, input requests, and persistence
  traces across memory providers, rather than reading `apps/ui` stores.

## Verification

- `pnpm check:esm`
- `pnpm typecheck`
- `pnpm test:core`
- `git diff --check`
