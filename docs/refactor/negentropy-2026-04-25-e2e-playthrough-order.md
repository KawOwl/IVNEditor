# Negentropy Report - 2026-04-25 E2E Playthrough Order Fix

Command:

```bash
cargo run --manifest-path /Users/kawowl/project/negentropy-labs/negentropy/Cargo.toml -- analyze . --format table --fail-on none --top 10
```

Exit code: `0`

## Summary

- Files scanned: `177`
- Modules: `177`
- Overall risk: `High`
- Extensions: `.cjs`, `.js`, `.jsx`, `.mjs`, `.mts`, `.ts`, `.tsx`

## Dimensions

| Dimension | Metric | Raw | Risk |
| --- | --- | ---: | --- |
| module_abstraction | IIE | `0.011` | Low |
| logic_cohesion | EAD | `2.0` | Medium |
| change_blast_radius | TCR | `0.006` | Low |
| architecture_decoupling | TCE | `0.006` | Low |
| testability_pluggability | EDR | `0.856` | Low |
| intent_redundancy | PLME | `0.0` | Low |
| state_encapsulation | SSE+OA | `{"oa":0.041,"sse":1.682}` | High |

## E2E Finding

- Ran the browser playthrough path against the remote `ivn_test` database with a local OpenAI-compatible mock LLM.
- The visible flow worked: published catalog -> new playthrough -> WebSocket session -> hall scene -> choice -> deep stacks -> Luna sprite change -> ending.
- Server logs exposed hidden persistence failures: concurrent tool/narrative callbacks could both choose the same `orderIdx`, causing `uniq_narrative_entry_order` violations. The UI continued because those persistence errors were caught, but restore/history could miss entries.

## Fix

- `PlaythroughService.appendNarrativeEntry` now takes a transaction-level PostgreSQL advisory lock scoped by `playthroughId` before reading `max(orderIdx)` and inserting.
- Added a concurrent append regression test that writes 20 entries for one playthrough and asserts contiguous unique `orderIdx` values.

## Verification

- Browser E2E after fix: latest playthrough finished with `orderIdx` `0..15`, state `{ chapter: 2, current_scene: "deep_stacks", met_luna: true, knows_secret: true }`, and no duplicate-key server log.
- `set -a; source /Users/kawowl/project/github.com/KawOwl/IVNEditor/.env; set +a; pnpm --filter @ivn/server test src/__tests__/playthrough-service.test.mts`
- `set -a; source /Users/kawowl/project/github.com/KawOwl/IVNEditor/.env; set +a; pnpm --filter @ivn/server test`
- `pnpm --filter @ivn/server typecheck`
- `pnpm check:esm`

## Follow-up Opinions

- The best long-term E2E path is a committed Playwright test with an in-process mock OpenAI-compatible endpoint and a disposable DB schema/database. Manual browser testing caught the bug, but it should become a repeatable CI check.
- `appendNarrativeEntry` still uses `max(orderIdx)+1`; the advisory lock makes it correct, but a per-playthrough counter column or DB-side sequence table would make the ordering contract more explicit.
- The current server tests mutate `ivn_test` heavily. Keeping browser E2E on a separate database would avoid reseeding after test runs.
