# Negentropy Report: Main DeepSeek Step Reasoning Merge

Date: 2026-04-26

Branch: `codex/code-quality-refactor`

Merged main commit:

- `5c354e2 fix(engine): 把 stub narrative entry 扩到每个非 followup step（含 narrative+tool step）`

## Integration Notes

- `main` changed the pre-refactor `GameSession` core loop.
- This branch had already moved generate-phase sequencing into `GenerateTurnRuntime`.
- Conflict resolution kept the refactored `GameSession` shape and ported the DeepSeek thinking replay fix into `packages/core/src/game-session/generate-turn-runtime.mts`.
- `persistToolOnlyStepReasoning` became `persistStepReasoning`.
- Reasoning stubs now apply to every non-follow-up step with `step.reasoning`, including narrative+tool steps.
- `signal-input-preflush` narrative entries no longer carry reasoning; per-step stub entries are the single reasoning persistence path.
- CoreEvent finalized reason was renamed from `tool-only-step-reasoning` to `step-reasoning`.

## Verification

```bash
pnpm --filter @ivn/core test -- generate-turn-runtime.test.mts messages-builder.test.mts core-event-protocol.test.mts session-emitter-projection.test.mts
pnpm test:core
pnpm typecheck
pnpm check:esm
negentropy analyze . --format json --fail-on none --output /tmp/ivn-negentropy-main-deepseek-step-reasoning-merge-2026-04-26.json
```

Results:

- Targeted core tests: 43 pass, 0 fail
- Full core tests: 263 pass, 0 fail
- Workspace typecheck: pass
- ESM check: pass
- Negentropy: exit 0 with `--fail-on none`

## Negentropy Summary

Source JSON:

- `/tmp/ivn-negentropy-main-deepseek-step-reasoning-merge-2026-04-26.json`

Summary:

- Files scanned: 218
- Modules: 218
- Overall risk: high
- High dimension: `state_encapsulation`
- Medium dimension: `logic_cohesion`

Top reported hotspots are existing server/UI/schema/test areas:

- `apps/server/src/operations/script/add-character-sprite.mts::exec`
- `apps/server/src/operations/script/add-background.mts::exec`
- `apps/ui/src/ui/editor/ScriptInfoPanel.tsx::anonymous@532`
- `packages/core/src/schemas.mts`
- `apps/server/src/db/schema.mts`
- `packages/core/src/architect/injection-rule-generator.mts`

No new hotspot is introduced by this merge slice.
