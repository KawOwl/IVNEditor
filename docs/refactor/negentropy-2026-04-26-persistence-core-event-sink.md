# Negentropy Report: Persistence CoreEvent Sink

Date: 2026-04-26

Branch: `codex/code-quality-refactor`

## Change Summary

- Added a durable `SessionPersistence` CoreEvent sink that interprets persistence
  callbacks from `SessionCoreEvent` data.
- Added `flushDurable()` support to `CoreEventSink` / `CoreEventBus`.
- Added a durable-first CoreEvent sink so persistence can be flushed before
  realtime projection consumers observe durable events.
- Removed direct `SessionPersistence` calls from `GameSession` and
  `GenerateTurnRuntime`.
- Routed memory evaluation harness persistence through CoreEvents as well.
- Made `tool-call-finished` self-contained with both `input` and `output`.
- Kept restore `waiting-input-started` as a projection event only, so restoring a
  waiting session does not rewrite waiting-input persistence.

## Verification

```bash
pnpm --filter @ivn/core test -- persistence-core-event-sink generate-turn-runtime memory-harness
pnpm test:core
pnpm typecheck
pnpm check:esm
cd apps/server && bun --env-file ../../.env test
MEMORY_EVAL_OUTPUT=/tmp/ivn-memory-live-eval-persistence-core-event-sink-2026-04-26.json pnpm eval:memory:live
negentropy analyze . --format json --fail-on none --baseline docs/refactor/negentropy-json/negentropy-2026-04-26-v1-readonly-runtime-protocol.json --output docs/refactor/negentropy-json/negentropy-2026-04-26-persistence-core-event-sink.json
```

Results:

- Targeted core tests: 7 pass, 0 fail
- Full core tests: 268 pass, 0 fail
- Workspace typecheck: pass
- ESM check: pass
- Server tests: 182 pass, 0 fail
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

- `docs/refactor/negentropy-json/negentropy-2026-04-26-persistence-core-event-sink.json`

Baseline JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-v1-readonly-runtime-protocol.json`

Summary:

- Tool version: `0.1.0`
- Files scanned: 223
- Modules: 223
- Overall risk: medium
- Medium dimensions: `logic_cohesion`, `state_encapsulation`

Delta:

- `module_abstraction`: `0.018` -> `0.016`; risk unchanged at low
- `logic_cohesion`: unchanged at medium
- `change_blast_radius`: unchanged at low
- `architecture_decoupling`: unchanged at low
- `testability_pluggability`: `0.863` -> `0.866`; risk unchanged at low
- `intent_redundancy`: unchanged at low
- `state_encapsulation`: `sse 1.604` -> `1.592`; risk improved high -> medium
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

The core runtime now treats persistence as a CoreEvent interpreter:

```text
GameSession / GenerateTurnRuntime
  -> publish SessionCoreEvent
  -> durable SessionPersistenceCoreEventSink
  -> flushDurable()
  -> realtime projection sinks
```

`SessionPersistence` remains in config as a compatibility adapter point, but the
runtime no longer calls persistence callbacks directly.
