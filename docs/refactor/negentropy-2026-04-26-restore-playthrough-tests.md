# Negentropy Report: Restore Playthrough Tests

## Summary

- Restored server DB coverage for `PlaythroughService` after removing the legacy
  narrative entry protocol.
- Restored `PlaythroughPersistence` coverage for the current CoreEvent-era
  contract: playthrough metadata/state is persisted on `playthroughs`, while
  content history is stored through CoreEvent logs.

## Command

```bash
negentropy analyze . --format json --fail-on none --baseline docs/refactor/negentropy-json/negentropy-2026-04-26-reset-drizzle-baseline.json --output docs/refactor/negentropy-json/negentropy-2026-04-26-restore-playthrough-tests.json
```

Run from `/Users/kawowl/.codex/worktrees/8023/IVNEditor` to avoid the main
worktree's untracked `.claude/worktrees` directory.

## Result

- Overall risk: `medium`
- Files scanned: `225`
- Baseline: `docs/refactor/negentropy-json/negentropy-2026-04-26-reset-drizzle-baseline.json`
- JSON report: `docs/refactor/negentropy-json/negentropy-2026-04-26-restore-playthrough-tests.json`

## Dimension Delta

- `module_abstraction` / IIE: `0.028 -> 0.025` (`low`)
- `logic_cohesion` / EAD: `2.0 -> 2.0` (`medium`)
- `change_blast_radius` / TCR: `0.0 -> 0.0` (`low`)
- `architecture_decoupling` / TCE: `0.0 -> 0.0` (`low`)
- `testability_pluggability` / EDR: `0.885 -> 0.877` (`low`)
- `intent_redundancy` / PLME: `0.0 -> 0.0` (`low`)
- `state_encapsulation` / SSE+OA: `sse 1.404 -> 1.404`, `oa 0.051 -> 0.051`
  (`medium`)

## Hotspot Delta

- Resolved hotspots: none
- New hotspots: none

## Verification

- `PATH="$HOME/.bun/bin:$PATH" pnpm --filter @ivn/server typecheck`: passed
- `PATH="$HOME/.bun/bin:$PATH" /Users/kawowl/.bun/bin/bun --env-file .env.test test src/__tests__/playthrough-service.test.mts src/__tests__/playthrough-persistence.test.mts`
  from `apps/server`: passed, `10` tests
