# Negentropy Report: V1 Readonly Runtime Protocol Boundary

Date: 2026-04-26

Branch: `codex/code-quality-refactor`

## Change Summary

- Added `protocol-version.mts` as the canonical protocol-version helper module.
- Made the current declarative visual protocol the default runtime protocol.
- Kept `v1-tool-call` as a legal data value for historical reading, linting,
  and migration tooling.
- Guarded `GameSession` and `GenerateTurnRuntime` so `v1-tool-call` fails before
  a session can run.
- Required `parserManifest` for runtime protocol execution.
- Updated memory evaluation harness defaults and deterministic fixtures to run
  through the declarative parser path.
- Updated editor prompt preview defaults to match runtime and marked the v1
  selector option as historical readonly.

## Verification

```bash
pnpm --filter @ivn/core test -- generate-turn-runtime.test.mts memory-evaluation-harness.test.mts session-emitter-projection.test.mts game-session-core-events.test.mts engine-rules.test.mts core-event-protocol.test.mts
pnpm test:core
pnpm typecheck
pnpm check:esm
cd apps/server && bun --env-file ../../.env test
MEMORY_EVAL_OUTPUT=/tmp/ivn-memory-live-eval-runtime-protocol-v1-readonly-2026-04-26.json pnpm eval:memory:live
negentropy analyze . --format json --fail-on none --baseline docs/refactor/negentropy-json/negentropy-2026-04-26-legacy-session-emitter-boundary.json --output docs/refactor/negentropy-json/negentropy-2026-04-26-v1-readonly-runtime-protocol.json
```

Results:

- Targeted core tests: 25 pass, 0 fail
- Full core tests: 266 pass, 0 fail
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

The warning was already seen in prior live harness runs and did not cause
protocol or projection failure.

## Negentropy Summary

Source JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-v1-readonly-runtime-protocol.json`

Baseline JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-legacy-session-emitter-boundary.json`

Summary:

- Tool version: `0.1.0`
- Files scanned: 221
- Modules: 221
- Overall risk: high
- High dimension: `state_encapsulation`
- Medium dimension: `logic_cohesion`

Delta:

- `module_abstraction`: `0.015` -> `0.018`; risk unchanged at low
- `logic_cohesion`: unchanged
- `change_blast_radius`: unchanged
- `architecture_decoupling`: unchanged
- `testability_pluggability`: `0.866` -> `0.863`; risk unchanged at low
- `intent_redundancy`: unchanged
- `state_encapsulation`: unchanged
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

The runtime boundary now follows the intended split:

```text
v1-tool-call
  -> readable by historical lint/parser/migration surfaces
  -> rejected by GameSession / GenerateTurnRuntime

current declarative visual protocol
  -> default runtime protocol
  -> parserManifest required
  -> CoreEvent / harness / WebSocket projection path
```

This does not remove legacy parsing code yet; it makes accidental execution of
legacy V1 sessions visible and non-runnable.
