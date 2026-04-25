# Negentropy Report: CoreEvent Protocol Validator

Date: 2026-04-26

Branch: `codex/code-quality-refactor`

## Change Summary

- Strengthened `validateCoreEventSequence` from shallow phase checks into a
  stricter session timing protocol validator.
- Added validation for terminal states, signal waiting causality, tool
  start/finish pairing, batch membership, assistant finalization, memory
  compaction phase, and player choice payload consistency.
- Extended protocol state with active input request, pending signal batch, and
  open tool-call tracking.
- Added targeted negative tests for the newly-covered timing hazards.

## Verification

```bash
pnpm --filter @ivn/core test -- core-event-protocol
pnpm --filter @ivn/core test -- memory-evaluation-harness
pnpm test:core
pnpm typecheck
pnpm check:esm
MEMORY_EVAL_OUTPUT=/tmp/ivn-memory-live-eval-core-event-protocol-2026-04-26.json pnpm eval:memory:live
negentropy analyze . --format json --fail-on none --baseline docs/refactor/negentropy-json/negentropy-2026-04-26-websocket-core-event-sink.json --output docs/refactor/negentropy-json/negentropy-2026-04-26-core-event-protocol-validator.json
```

Results:

- CoreEvent protocol tests: 6 pass, 0 fail
- Memory harness test: 1 pass, 0 fail
- Full core tests: 272 pass, 0 fail
- Workspace typecheck: pass
- ESM check: pass
- Live memory eval: pass
  - scenario: `live-memory-silver-key`
  - variants: `legacy`, `llm-summarizer`
  - turns: `legacy:2`, `llm-summarizer:2`
  - inputRequests: `2, 2`
  - sessionEmitterProjection: `ok`
  - LLM `thinkingEnabled=false`
  - LLM `reasoningEffort=null`
- Negentropy: exit 0 with `--fail-on none`

Live eval warning observed:

```text
[llm-client] follow-up streamText finished without eliciting signal_input_needed. followupFinish=stop, mainFinish=stop
```

The warning matches prior live harness runs and did not cause protocol or
projection failure.

## Negentropy Summary

Source JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-core-event-protocol-validator.json`

Baseline JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-websocket-core-event-sink.json`

Summary:

- Tool version: `0.1.0`
- Files scanned: 222
- Modules: 222
- Overall risk: medium
- Medium dimensions: `logic_cohesion`, `state_encapsulation`

Delta:

- `module_abstraction`: unchanged at low
- `logic_cohesion`: unchanged at medium
- `change_blast_radius`: unchanged at low
- `architecture_decoupling`: unchanged at low
- `testability_pluggability`: `0.870` -> `0.872`; risk unchanged at low
- `intent_redundancy`: unchanged at low
- `state_encapsulation`: unchanged at medium
- `new_hotspots`: none
- `resolved_hotspots`: none

Top reported hotspots remain existing server/UI/schema/test areas:

- `apps/server/src/operations/script/add-character-sprite.mts::exec`
- `apps/server/src/operations/script/add-background.mts::exec`
- `apps/ui/src/ui/editor/ScriptInfoPanel.tsx::anonymous@532`
- `packages/core/src/schemas.mts`
- `apps/server/src/db/schema.mts`
- `packages/core/src/architect/injection-rule-generator.mts`

## Boundary Note

The validator now checks the specific timing invariants this refactor has been
trying to make explicit:

```text
generate -> signal recorded -> generate completed -> waiting input -> player input
tool start -> tool finish
assistant start -> assistant finalized -> generate completed
terminal session -> no further runtime events
```

It remains a report-producing validator rather than a runtime exception path.
