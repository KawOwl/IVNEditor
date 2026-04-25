# Negentropy Report: Recording Session Output Sink

Date: 2026-04-26

Branch: `codex/code-quality-refactor`

## Change Summary

- Added `RecordingSessionOutputSink`, a CoreEvent-native interpreter that
  produces the same `RecordedSessionOutput` shape as the legacy
  `RecordingSessionEmitter`.
- Moved memory evaluation, live evaluation, `GenerateTurnRuntime`, and
  `GameSession` CoreEvent tests off the legacy SessionEmitter projection for
  recording.
- Kept the legacy projection as a golden compatibility comparison for
  historical readback and migration safety.
- Updated the CoreEvent architecture note and legacy SessionEmitter comments to
  reflect the new boundary.

## Verification

```bash
pnpm --filter @ivn/core test -- recording-session-output generate-turn-runtime memory-evaluation-harness game-session-core-events
pnpm typecheck
pnpm test:core
pnpm check:esm
MEMORY_EVAL_OUTPUT=/tmp/ivn-memory-live-eval-recording-session-output-2026-04-26.json pnpm eval:memory:live
negentropy analyze . --format json --fail-on none --baseline docs/refactor/negentropy-json/negentropy-2026-04-26-core-event-architecture-doc.json --output docs/refactor/negentropy-json/negentropy-2026-04-26-recording-session-output-sink.json
```

Results:

- Targeted CoreEvent/session-output tests: 9 pass, 0 fail
- Workspace typecheck: pass
- Core test suite: 275 pass, 0 fail
- ESM check: pass
- Live memory eval: pass
  - scenario: `live-memory-silver-key`
  - variants: `legacy`, `llm-summarizer`
  - turns: `2`, `2`
  - input requests: `2`, `2`
  - CoreEvent protocol: `ok` for both variants
  - SessionEmitter projection comparison: `ok`
  - LLM `thinkingEnabled=false`
  - LLM `reasoningEffort=null`
- Negentropy: exit 0 with `--fail-on none`

## Negentropy Summary

Source JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-recording-session-output-sink.json`

Baseline JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-core-event-architecture-doc.json`

Summary:

- Tool version: `0.1.0`
- Files scanned: 226
- Modules: 226
- Overall risk: medium
- Medium dimensions: `logic_cohesion`, `state_encapsulation`

Delta:

- Risk levels unchanged for all dimensions.
- `module_abstraction` improved slightly: `0.015 -> 0.014`.
- `testability_pluggability` moved slightly: `0.872 -> 0.873`, still low.
- `state_encapsulation` changed from `oa=0.040, sse=1.558` to
  `oa=0.054, sse=1.537`, still medium.
- `new_hotspots`: none.
- `resolved_hotspots`: none.

## Note

The first scan flagged the new recorder's large CoreEvent switch as a new
logic-cohesion hotspot. The recorder was split into smaller event handlers, and
the final saved JSON has no new hotspots.
