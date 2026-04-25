# Negentropy Report: Main CoreEvent Merge

Date: 2026-04-26

Branch: `main`

## Change Summary

- Merged `codex/code-quality-refactor` into `main`.
- Resolved the migration-number conflict with the existing main soft-delete
  migration by renaming CoreEvent log persistence from `0013` to `0014`.
- Kept the CoreEvent restore/runtime, durable event-log sequencing, input-panel
  restore visibility, and related documentation changes intact.

## Verification

```bash
pnpm install
pnpm typecheck
pnpm check:esm
bun test packages/core/src/__tests__/core-event-log-restore.test.mts packages/core/src/__tests__/event-log-core-event-sink.test.mts apps/ui/src/ui/__tests__/input-panel-visibility.test.mts
pnpm test:core
git diff --check
negentropy analyze <clean mirror> --format json --fail-on none --baseline docs/refactor/negentropy-json/negentropy-2026-04-26-core-event-log-sequence-doc.json --output docs/refactor/negentropy-json/negentropy-2026-04-26-main-core-event-merge.json
```

Results:

- `pnpm install`: pass; lockfile already up to date.
- `pnpm typecheck`: pass.
- `pnpm check:esm`: pass.
- Targeted CoreEvent/UI tests: pass, 12 tests.
- `pnpm test:core`: pass, 283 tests.
- `git diff --check`: pass.
- Server DB persistence tests: blocked by the test DB guard because this main
  worktree only has `apps/server/.env` pointing at `ivn_dev`; the guard refused
  destructive cleanup on a non-test database.
- Negentropy: exit 0 with `--fail-on none`.

## Negentropy Summary

Source JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-main-core-event-merge.json`

Baseline JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-core-event-log-sequence-doc.json`

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

Note: the scan was run against a clean mirror of the worktree that excluded
untracked local directories such as `.claude/worktrees/`, plus dependency and
environment files, so the report reflects tracked project code rather than
temporary agent worktrees.
