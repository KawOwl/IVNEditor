# Negentropy Report: CoreEvent Log Sequence Allocation

Date: 2026-04-26

Branch: `codex/code-quality-refactor`

## Change Summary

- Changed server CoreEvent log persistence to allocate `sequence` inside the
  database transaction with a per-playthrough advisory lock.
- This prevents restore/reconnect from reusing a stale `initialSequence` when a
  previous WebSocket sink still has pending CoreEvent appends.
- Browser E2E caught the issue as a duplicate
  `uniq_core_event_envelope_sequence` write during player readback/continue.

## Verification

```bash
/Users/kawowl/.bun/bin/bun test packages/core/src/__tests__/event-log-core-event-sink.test.mts packages/core/src/__tests__/core-event-log-restore.test.mts
/Users/kawowl/.bun/bin/bunx --bun pnpm --filter @ivn/server typecheck
git diff --check
negentropy analyze . --format json --fail-on none --baseline docs/refactor/negentropy-json/negentropy-2026-04-26-event-log-restore-runtime.json --output docs/refactor/negentropy-json/negentropy-2026-04-26-core-event-log-sequence-allocation.json
```

Results:

- Core targeted tests: 8 pass, 0 fail
- Server typecheck: pass
- Diff whitespace check: pass
- Browser E2E, player flow:
  - opened current worktree UI at `http://127.0.0.1:5175`
  - new production playthrough reached `waiting-input`
  - browser reload returned to catalog, playthrough list restored the save
  - submitted restored choice and confirmed DB turn advanced `2 -> 3`
  - CoreEvent log advanced to `count=848`, `max_sequence=848`, duplicate
    sequence query returned none
- Browser E2E, editor playtest flow:
  - logged in as temporary admin `codex_e2e_652f`
  - loaded `E2E 测试 · 图书馆奇遇` in the editor
  - started a `kind=playtest` run from the right-side `试玩` tab
  - returned to the playtest list and restored the playtest choices
- Negentropy: exit 0 with `--fail-on none`

## Negentropy Summary

Source JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-core-event-log-sequence-allocation.json`

Baseline JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-event-log-restore-runtime.json`

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
