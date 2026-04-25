# Negentropy Report: Legacy V1 Readback Boundary

Date: 2026-04-26

Branch: `codex/code-quality-refactor`

## Change Summary

- Added `legacy-v1-readback`, a readonly boundary that reconstructs Sentence
  streams from historical `v1-tool-call` narrative entries.
- The readback path interprets old `<d>` XML-lite narrative text and historical
  visual tool calls (`change_scene`, `change_sprite`, `clear_stage`) without
  running `GameSession` or using SessionEmitter projection.
- Removed deprecated SessionEmitter projection aliases and stopped re-exporting
  the legacy projection from the `game-session` barrel.
- Updated the CoreEvent architecture note: V1 history is readable through the
  dedicated readback module; legacy SessionEmitter projection is now only an
  internal golden comparison tool.

## Verification

```bash
pnpm --filter @ivn/core test -- legacy-v1-readback session-emitter-projection recording-session-output memory-evaluation-harness generate-turn-runtime game-session-core-events
pnpm --filter @ivn/core typecheck
pnpm test:core
pnpm check:esm
pnpm typecheck
MEMORY_EVAL_OUTPUT=/tmp/ivn-memory-live-eval-legacy-v1-readback-boundary-2026-04-26.json pnpm eval:memory:live
negentropy analyze . --format json --fail-on none --baseline docs/refactor/negentropy-json/negentropy-2026-04-26-recording-session-output-sink.json --output docs/refactor/negentropy-json/negentropy-2026-04-26-legacy-v1-readback-boundary.json
```

Results:

- Targeted CoreEvent/readback tests: 14 pass, 0 fail
- Core typecheck: pass
- Core test suite: 277 pass, 0 fail
- ESM check: pass
- Workspace typecheck: pass
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

- `docs/refactor/negentropy-json/negentropy-2026-04-26-legacy-v1-readback-boundary.json`

Baseline JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-recording-session-output-sink.json`

Summary:

- Tool version: `0.1.0`
- Files scanned: 228
- Modules: 228
- Overall risk: medium
- Medium dimensions: `logic_cohesion`, `state_encapsulation`

Delta:

- Risk levels unchanged for all dimensions.
- `testability_pluggability` moved slightly: `0.873 -> 0.874`, still low.
- `state_encapsulation.oa` moved slightly: `0.054 -> 0.058`, still medium;
  `state_encapsulation.sse` unchanged at `1.537`.
- `new_hotspots`: none.
- `resolved_hotspots`: none.

## Boundary Note

This closes the planned CoreEvent migration boundary: V1 is readable but not
runnable, while current runtime output flows through CoreEvent sinks. Remaining
work such as durable event-log storage or replay-as-restore is follow-on
capability work, not a CoreEvent migration blocker.
