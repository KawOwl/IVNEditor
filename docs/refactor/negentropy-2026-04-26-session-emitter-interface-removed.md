# Negentropy Report: SessionEmitter Removed From Core Runtime Deps

Date: 2026-04-26

Branch: `codex/code-quality-refactor`

## Change Summary

- `GameSession` no longer accepts or stores a `SessionEmitter`.
- `GenerateTurnRuntime` no longer accepts or stores a `SessionEmitter`.
- Core runtime output now flows through `CoreEventSink` only.
- Existing `SessionEmitter` consumers are preserved through
  `createSessionEmitterProjection`.
- The memory evaluation harness now feeds runtime CoreEvents into the projection
  when it needs legacy recording output for parity checks.
- Server session construction now creates `GameSession` without a noop emitter.

## Verification

```bash
pnpm --filter @ivn/core test -- generate-turn-runtime.test.mts game-session-core-events.test.mts session-emitter-projection.test.mts memory-evaluation-harness.test.mts core-event-protocol.test.mts
pnpm typecheck
pnpm check:esm
pnpm test:core
cd apps/server && bun --env-file ../../.env test
MEMORY_EVAL_OUTPUT=/tmp/ivn-memory-live-eval-session-emitter-interface-removed-2026-04-26.json pnpm eval:memory:live
negentropy analyze . --format json --fail-on none --output /tmp/ivn-negentropy-session-emitter-interface-removed-2026-04-26.json
```

Results:

- Targeted core tests: 11 pass, 0 fail
- Workspace typecheck: pass
- ESM check: pass
- Full core tests: 264 pass, 0 fail
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

The warning was already seen in prior live harness runs and did not cause
protocol or projection failure.

## Negentropy Summary

Source JSON:

- `/tmp/ivn-negentropy-session-emitter-interface-removed-2026-04-26.json`

Summary:

- Tool version: `0.1.0`
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

## Architecture Note

`SessionEmitter` is now a legacy projection target instead of a core runtime
dependency. That keeps WebSocket and recording compatibility in place while the
core loop becomes event-first:

```text
GameSession / GenerateTurnRuntime
  -> CoreEventSink
  -> createSessionEmitterProjection
  -> SessionEmitter adapters
```

The remaining migration surface is naming and ownership: the legacy emitter
files can now be renamed or relocated once downstream imports are ready for the
compatibility boundary to become explicit.
