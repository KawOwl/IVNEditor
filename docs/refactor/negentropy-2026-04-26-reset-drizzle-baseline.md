# Negentropy Report: Reset Drizzle Baseline

## Summary

- Cleared the checked-in Drizzle migration history to an empty baseline.
- Removed the obsolete bootstrap migration marker script and package command.
- Documented the required Drizzle workflow for all future database changes.
- Cleared `drizzle.__drizzle_migrations` records in `ivn_test`, `ivn_dev`, and
  `ivn_staging` while preserving business schema and data.

## Command

```bash
negentropy analyze . --format json --fail-on none --baseline docs/refactor/negentropy-json/negentropy-2026-04-26-remove-legacy-content-protocol.json --output docs/refactor/negentropy-json/negentropy-2026-04-26-reset-drizzle-baseline.json
```

## Result

- Overall risk: `medium`
- Files scanned: `223`
- Baseline: `docs/refactor/negentropy-json/negentropy-2026-04-26-remove-legacy-content-protocol.json`
- JSON report: `docs/refactor/negentropy-json/negentropy-2026-04-26-reset-drizzle-baseline.json`

## Dimension Delta

- `module_abstraction` / IIE: `0.027 -> 0.028` (`low`)
- `logic_cohesion` / EAD: `2.0 -> 2.0` (`medium`)
- `change_blast_radius` / TCR: `0.0 -> 0.0` (`low`)
- `architecture_decoupling` / TCE: `0.0 -> 0.0` (`low`)
- `testability_pluggability` / EDR: `0.885 -> 0.885` (`low`)
- `intent_redundancy` / PLME: `0.0 -> 0.0` (`low`)
- `state_encapsulation` / SSE+OA: `sse 1.404 -> 1.404`, `oa 0.051 -> 0.051`
  (`medium`)

## Hotspot Delta

- Resolved hotspots: none
- New hotspots: none

## Verification

- `PATH="$HOME/.bun/bin:$PATH" pnpm check`: passed
- `cd apps/server && /Users/kawowl/.bun/bin/bun --env-file=.env.test drizzle-kit check --config drizzle.config.mts`: passed
- `pnpm --filter @ivn/server typecheck`: passed
- `cd apps/server && /Users/kawowl/.bun/bin/bun --env-file=.env.test -e "const db = await import('./src/db/index.mts'); await db.testConnection(); await db.runMigrations(); await db.closePool();"`:
  passed
- Verified `drizzle.__drizzle_migrations` count is `0` in `ivn_test`,
  `ivn_dev`, and `ivn_staging`.
