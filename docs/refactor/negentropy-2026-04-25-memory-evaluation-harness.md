# Negentropy Report - 2026-04-25 Memory Evaluation Harness

Command:

```bash
cargo run --quiet --manifest-path /Users/kawowl/project/github.com/negentropy-labs/negentropy/Cargo.toml -- analyze . --format json --fail-on none --output /tmp/ivn-negentropy-memory-evaluation-harness-2026-04-25.json
```

Exit code: `0`

The scan completed with `--fail-on none` so the memory evaluation harness slice
could record repository signal without blocking on existing high-risk hotspots.

## Summary

- Tool version: `0.1.0`
- Files scanned: `183`
- Modules: `183`
- Overall risk: `High`
- Extensions: `.cjs`, `.js`, `.jsx`, `.mjs`, `.mts`, `.ts`, `.tsx`

## Dimensions

| Dimension | Metric | Raw | Risk |
| --- | --- | ---: | --- |
| module_abstraction | IIE | `0.0` | Low |
| logic_cohesion | EAD | `2.0` | Medium |
| change_blast_radius | TCR | `0.0` | Low |
| architecture_decoupling | TCE | `0.0` | Low |
| testability_pluggability | EDR | `0.864` | Low |
| intent_redundancy | PLME | `0.0` | Low |
| state_encapsulation | SSE+OA | `{"oa":0.039,"sse":1.659}` | High |

## Refactor Impact

- Added a deterministic memory evaluation harness around
  `createRecordingSessionEmitter`, `GenerateTurnRuntime`, scripted inputs, and
  swappable `MemoryConfig` variants.
- Added an in-memory `SessionPersistence` + `NarrativeHistoryReader` so memory
  adapters read canonical `narrative_entries`-shaped history in eval runs.
- Added a scripted LLM fixture that can simulate generate turns, tool calls, and
  summarizer compression without calling live providers.
- Narrowed the llm-summarizer dependency from a concrete `LLMClient` to
  `Pick<LLMClient, 'generate'>`, which keeps the adapter easier to test.
- Documented that future live DeepSeek eval runners must keep
  `thinkingEnabled=false` and `reasoningEffort=null` until thinking-mode replay
  is adapted.

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

- The new harness is intentionally deterministic and provider-free. It is the
  repeatable core-loop layer before adding a live DeepSeek or browser E2E runner.
- The next useful eval slice is likely a small CLI/server script that loads a
  real script manifest, calls `runMemoryEvaluationSuite`, and writes JSON reports
  for chosen memory configs.
- Existing state-encapsulation risk remains repository-wide and is not driven by
  this harness.

## Verification

- `pnpm check:esm`
- `pnpm typecheck`
- `pnpm test:core`
- `git diff --check`
