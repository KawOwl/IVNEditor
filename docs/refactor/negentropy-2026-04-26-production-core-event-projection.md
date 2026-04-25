# Negentropy Report - 2026-04-26 Production Core Event Projection

Command:

```bash
negentropy analyze . --format json --fail-on none --output /tmp/ivn-negentropy-production-core-event-projection-2026-04-26.json
```

Exit code: `0`

The scan completed with `--fail-on none` so the production WebSocket projection
slice could record repository signal without blocking on existing high-risk
hotspots.

## Summary

- Tool version: `0.1.0`
- Files scanned: `218`
- Modules: `218`
- Overall risk: `High`
- Extensions: `.cjs`, `.js`, `.jsx`, `.mjs`, `.mts`, `.ts`, `.tsx`

## Dimensions

| Dimension | Metric | Raw | Risk |
| --- | --- | ---: | --- |
| module_abstraction | IIE | `0.015` | Low |
| logic_cohesion | EAD | `2.0` | Medium |
| change_blast_radius | TCR | `0.0` | Low |
| architecture_decoupling | TCE | `0.0` | Low |
| testability_pluggability | EDR | `0.866` | Low |
| intent_redundancy | PLME | `0.0` | Low |
| state_encapsulation | SSE+OA | `{"oa":0.039,"sse":1.604}` | High |

## Refactor Impact

- Added `createNoopSessionEmitter` so server runtime can stop writing directly
  to the legacy `SessionEmitter` output port.
- Added `createWebSocketCoreEventSink`, which wraps the existing
  `WebSocketSessionEmitter` behind `createSessionEmitterProjection`.
- Switched `GameSessionWrapper.attachWebSocket()` to construct `GameSession`
  with a noop emitter and pass the WebSocket projection as `coreEventSink` in
  both start and restore configs.
- Added restore-finished projection coverage so restored finished playthroughs
  still emit the legacy `finished` status.
- Added generate-error CoreEvent publication from `GenerateTurnRuntime` so
  projected server sessions still surface generation failures.

## Local Playtest Logs

Before the production switch, a manual browser playtest produced normal server
logs:

- `[WS] open`
- `[WS] msg start`
- multiple `[WS] msg input`
- reconnect/open/start/input for a second playthrough

No backend errors, persistence failures, or LLM exceptions appeared in the dev
server output.

## Live Harness Run

Command:

```bash
PATH="/Users/kawowl/.local/share/fnm/node-versions/v24.15.0/installation/bin:/Users/kawowl/.bun/bin:$PATH" MEMORY_EVAL_OUTPUT=/tmp/ivn-memory-live-eval-production-projection-2026-04-26.json /Users/kawowl/.bun/bin/bunx pnpm@10.12.4 eval:memory:live
```

Result:

- Scenario: `live-memory-silver-key`
- Variants: `legacy`, `llm-summarizer`
- Turns: `legacy:2`, `llm-summarizer:2`
- Input requests: `2`, `2`
- CoreEvent protocol: `ok` for both variants
- SessionEmitter projection: `ok` for both variants
- LLM config observed by runner: `thinkingEnabled=false`,
  `reasoningEffort=null`

## Dev Server Smoke

Command:

```bash
PATH="/Users/kawowl/.local/share/fnm/node-versions/v24.15.0/installation/bin:/Users/kawowl/.bun/bin:$PATH" /Users/kawowl/.bun/bin/bunx pnpm@10.12.4 dev:all
```

Result:

- Server started at `http://localhost:3001`
- UI started at `http://localhost:5175` because `5174` was already occupied
- `curl -I http://localhost:5175/` returned `200`
- `curl http://localhost:3001/health` returned `{"ok":true,...}`

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

- Production WebSocket output is now driven by CoreEvents, but core still keeps
  direct `SessionEmitter` calls for deterministic harnesses and remaining
  migration safety.
- The next useful slice is to migrate deterministic harnesses and tests to a
  CoreEvent-first runtime path, then remove direct legacy emitter calls from
  `GameSession` / `GenerateTurnRuntime`.
- Existing state-encapsulation risk remains repository-wide and is not driven by
  this slice.

## Verification

- `pnpm --filter @ivn/core test`
- `bun --env-file ../../.env test` from `apps/server`
- `pnpm --filter @ivn/core typecheck`
- `pnpm --filter @ivn/server typecheck`
- `pnpm typecheck`
- `pnpm check:esm`
- `pnpm eval:memory:live`
- `pnpm dev:all` startup smoke
- `git diff --check`
