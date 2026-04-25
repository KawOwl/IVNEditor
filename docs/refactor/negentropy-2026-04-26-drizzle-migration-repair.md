# Negentropy Report: Drizzle Migration Repair

Date: 2026-04-26

Branch: `main`

## Change Summary

- Added `0015_repair_scripts_deleted_at` as an idempotent repair migration for
  environments that skipped `0013_scripts_soft_delete`.
- Documented the Drizzle migration ordering incident and the rule that journal
  `when` values must not go backwards.

## Verification

```bash
git diff --check
pnpm check:esm
pnpm typecheck
negentropy analyze <clean mirror> --format json --fail-on none --baseline docs/refactor/negentropy-json/negentropy-2026-04-26-main-core-event-merge.json --output docs/refactor/negentropy-json/negentropy-2026-04-26-drizzle-migration-repair.json
```

Results:

- Journal tail check: pass; `0015_repair_scripts_deleted_at` is newer than
  `0014_core_event_envelopes`.
- `git diff --check`: pass.
- `pnpm check:esm`: pass.
- `pnpm typecheck`: pass.
- Negentropy: exit 0 with `--fail-on none`.

## Negentropy Summary

Source JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-drizzle-migration-repair.json`

Baseline JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-main-core-event-merge.json`

Summary:

- Tool version: `0.1.0`
- Files scanned: 235
- Modules: 235
- Overall risk: medium
- Medium dimensions: `logic_cohesion`, `state_encapsulation`

Delta:

- All dimension raw values unchanged from baseline.
- `new_hotspots`: none
- `resolved_hotspots`: none
