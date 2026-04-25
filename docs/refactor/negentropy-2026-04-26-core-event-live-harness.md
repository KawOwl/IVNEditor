# Negentropy Report - 2026-04-26 Core Event Live Harness

Command:

```bash
negentropy analyze . --format json --fail-on none --output /tmp/ivn-negentropy-core-event-live-harness-2026-04-26.json
```

Exit code: `0`

The scan completed with `--fail-on none` so this CoreEvent/live-harness slice
could record repository signal without blocking on existing high-risk hotspots.

## Summary

- Tool version: `0.1.0`
- Files scanned: `214`
- Modules: `214`
- Overall risk: `High`
- Extensions: `.cjs`, `.js`, `.jsx`, `.mjs`, `.mts`, `.ts`, `.tsx`

## Dimensions

| Dimension | Metric | Raw | Risk |
| --- | --- | ---: | --- |
| module_abstraction | IIE | `0.017` | Low |
| logic_cohesion | EAD | `2.0` | Medium |
| change_blast_radius | TCR | `0.0` | Low |
| architecture_decoupling | TCE | `0.0` | Low |
| testability_pluggability | EDR | `0.859` | Low |
| intent_redundancy | PLME | `0.0` | Low |
| state_encapsulation | SSE+OA | `{"oa":0.036,"sse":1.604}` | High |

## Refactor Impact

- Added a `SessionCoreEvent` model for the core loop without embedding protocol
  version labels in the event names or payloads.
- Added a recording CoreEvent sink and a protocol validator that checks the
  ordering invariants currently most likely to regress: generate phase,
  waiting-input phase, input request identity, and narrative batch finalization.
- Dual-wrote CoreEvents from `GameSession`, `GenerateTurnRuntime`, and the
  memory evaluation harness while keeping the legacy `SessionEmitter` path in
  place.
- Added a live memory evaluation runner that uses the same harness against a
  real LLM provider.
- Forced live DeepSeek-compatible runs to use `thinkingEnabled=false` and
  `reasoningEffort=null`; the runner intentionally ignores env thinking flags.

## Live Harness Run

Command:

```bash
PATH="/Users/kawowl/.bun/bin:$PATH" MEMORY_EVAL_OUTPUT=/tmp/ivn-memory-live-eval-2026-04-26.json /Users/kawowl/.bun/bin/bunx pnpm@10.12.4 eval:memory:live
```

Result:

- Scenario: `live-memory-silver-key`
- Variants: `legacy`, `llm-summarizer`
- Turns: `legacy:2`, `llm-summarizer:2`
- Input requests: `2`, `2`
- CoreEvent protocol: `ok` for both variants
- LLM config observed by runner: `thinkingEnabled=false`,
  `reasoningEffort=null`
- `llm-summarizer` compression calls: `1`

The run emitted a provider warning for one follow-up attempt that did not call
`signal_input_needed`, but both variants still reached the second unscripted
input boundary and passed CoreEvent protocol validation.

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

## Repository Notes

- The new CoreEvent layer is observational in this slice. It is suitable for
  validating the planned event protocol, but the WebSocket emitter and legacy
  `SessionEmitter` consumers have not been removed yet.
- The live runner exercises the same memory harness path as deterministic tests,
  which gives the protocol validator coverage over real provider timing without
  changing production runtime behavior.
- Existing state-encapsulation risk remains repository-wide and is not driven by
  this slice.

## Verification

- `pnpm --filter @ivn/core test`
- `pnpm --filter @ivn/core typecheck`
- `pnpm check:esm`
- `pnpm typecheck`
- `pnpm eval:memory:live`
- `git diff --check`
