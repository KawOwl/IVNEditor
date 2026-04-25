# Negentropy Report: Outer GameSession CoreEvent-First Session

Date: 2026-04-26

Branch: `codex/code-quality-refactor`

## Change Summary

- `GameSession` now projects its own lifecycle and receive-phase CoreEvents to the local `SessionEmitter`.
- Direct outer `SessionEmitter` calls were removed for:
  - `start` loading/debug/scene output
  - `restore` loading/debug/scene/waiting/finished output
  - `stop` idle output
  - scenario-finished output
  - receive-phase waiting/input output
- `publishCoreEvent` now performs local projection and then forwards to the configured downstream sink.
- `GenerateTurnRuntime` remains CoreEvent-first from the prior slice.
- Added a focused GameSession lifecycle test for restored + stopped CoreEvents.

## Verification

```bash
pnpm --filter @ivn/core test -- game-session-core-events.test.mts generate-turn-runtime.test.mts session-emitter-projection.test.mts memory-evaluation-harness.test.mts core-event-protocol.test.mts
pnpm test:core
pnpm typecheck
pnpm check:esm
cd apps/server && bun --env-file ../../.env test
MEMORY_EVAL_OUTPUT=/tmp/ivn-memory-live-eval-outer-core-event-first-2026-04-26.json pnpm eval:memory:live
negentropy analyze . --format json --fail-on none --output /tmp/ivn-negentropy-outer-core-event-first-2026-04-26.json
```

Results:

- Targeted core tests: 11 pass, 0 fail
- Full core tests: 264 pass, 0 fail
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

This warning was present before this slice and did not cause projection or protocol failure.

## Negentropy Summary

Source JSON:

- `/tmp/ivn-negentropy-outer-core-event-first-2026-04-26.json`

Summary:

- Files scanned: 219
- Modules: 219
- Overall risk: high
- High dimension: `state_encapsulation`
- Medium dimension: `logic_cohesion`

Top reported hotspots remain existing server/UI/schema/test areas:

- `apps/server/src/operations/script/add-character-sprite.mts::exec`
- `apps/server/src/operations/script/add-background.mts::exec`
- `apps/ui/src/ui/editor/ScriptInfoPanel.tsx::anonymous@532`
- `packages/core/src/schemas.mts`
- `apps/server/src/db/schema.mts`
- `packages/core/src/architect/injection-rule-generator.mts`

No new hotspot is introduced by this slice.
