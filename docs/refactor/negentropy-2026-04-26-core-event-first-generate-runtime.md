# Negentropy Report: CoreEvent-First Generate Runtime

Date: 2026-04-26

Branch: `codex/code-quality-refactor`

## Change Summary

- `GenerateTurnRuntime` now treats CoreEvent as the generate-phase output path.
- Legacy `SessionEmitter` output for generate events is produced by `createSessionEmitterProjection`.
- Direct generate-phase emitter calls were removed from:
  - context/debug projection
  - streaming entry start/text/reasoning/finalize
  - tool call pending/result updates
  - narrative sentence output
  - scene-change output
  - signal-input sentence output
  - memory compaction status
  - generate error projection
- Memory evaluation harness start/waiting/receive/finish output now also goes through CoreEvent + projection.
- Server runtime remains on the production CoreEvent-to-WebSocket path added earlier.

## Verification

```bash
pnpm --filter @ivn/core test -- generate-turn-runtime.test.mts session-emitter-projection.test.mts memory-evaluation-harness.test.mts core-event-protocol.test.mts
pnpm test:core
pnpm typecheck
pnpm check:esm
MEMORY_EVAL_OUTPUT=/tmp/ivn-memory-live-eval-core-event-first-generate-2026-04-26.json pnpm eval:memory:live
cd apps/server && bun --env-file ../../.env test
negentropy analyze . --format json --fail-on none --output /tmp/ivn-negentropy-core-event-first-generate-2026-04-26.json
```

Results:

- Targeted core tests: 10 pass, 0 fail
- Full core tests: 263 pass, 0 fail
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
- Server tests: 182 pass, 0 fail
- Negentropy: exit 0 with `--fail-on none`

Live eval warning observed:

```text
[llm-client] follow-up streamText finished without eliciting signal_input_needed. followupFinish=stop, mainFinish=stop
```

This warning was already present in the previous live harness run and did not cause projection or protocol failure.

## Negentropy Summary

Source JSON:

- `/tmp/ivn-negentropy-core-event-first-generate-2026-04-26.json`

Summary:

- Files scanned: 218
- Modules: 218
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
