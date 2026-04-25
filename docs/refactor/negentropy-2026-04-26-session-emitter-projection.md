# Negentropy Report - 2026-04-26 Session Emitter Projection

Command:

```bash
negentropy analyze . --format json --fail-on none --output /tmp/ivn-negentropy-session-emitter-projection-2026-04-26.json
```

Exit code: `0`

The scan completed with `--fail-on none` so the CoreEvent projection slice could
record repository signal without blocking on existing high-risk hotspots.

## Summary

- Tool version: `0.1.0`
- Files scanned: `216`
- Modules: `216`
- Overall risk: `High`
- Extensions: `.cjs`, `.js`, `.jsx`, `.mjs`, `.mts`, `.ts`, `.tsx`

## Dimensions

| Dimension | Metric | Raw | Risk |
| --- | --- | ---: | --- |
| module_abstraction | IIE | `0.017` | Low |
| logic_cohesion | EAD | `2.0` | Medium |
| change_blast_radius | TCR | `0.0` | Low |
| architecture_decoupling | TCE | `0.0` | Low |
| testability_pluggability | EDR | `0.866` | Low |
| intent_redundancy | PLME | `0.0` | Low |
| state_encapsulation | SSE+OA | `{"oa":0.036,"sse":1.604}` | High |

## Refactor Impact

- Added `createSessionEmitterProjection`, a CoreEvent consumer that replays the
  new session event protocol into the existing `SessionEmitter` port.
- Added sentence-level CoreEvents for the v1 tool-driven narrative runtime so
  legacy `appendSentence` behavior can be reconstructed from CoreEvents.
- Added `scene-changed` CoreEvent coverage for v1 visual tool transitions,
  preserving the legacy ordering of `emitSceneChange` before the
  `scene_change` sentence.
- Extended the memory evaluation harness with a `sessionEmitterProjection`
  report that fails when projected recording output differs from direct legacy
  emitter output.
- Updated the live memory evaluation runner to fail on projection mismatches in
  addition to CoreEvent protocol violations.

## Live Harness Run

Command:

```bash
PATH="/Users/kawowl/.bun/bin:$PATH" MEMORY_EVAL_OUTPUT=/tmp/ivn-memory-live-eval-projection-2026-04-26.json /Users/kawowl/.bun/bin/bunx pnpm@10.12.4 eval:memory:live
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

The provider again emitted a follow-up warning for one attempt that did not call
`signal_input_needed`, but both variants reached the second unscripted input
boundary and passed both CoreEvent protocol validation and SessionEmitter
projection validation.

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

- The first projection implementation briefly appeared as a new logic-cohesion
  hotspot because all event interpretation lived in one switch. It was split
  into explicit per-event handlers before this report was recorded.
- The projection layer is still observational: production code continues to
  dual-write CoreEvents and legacy `SessionEmitter` calls.
- This slice makes the next migration step measurable: production can be moved
  to `CoreEvent -> SessionEmitterProjection -> WebSocketSessionEmitter` while
  retaining direct-output parity tests.

## Verification

- `pnpm --filter @ivn/core test`
- `pnpm --filter @ivn/core typecheck`
- `pnpm check:esm`
- `pnpm typecheck`
- `pnpm eval:memory:live`
- `git diff --check`
