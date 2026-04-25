# Negentropy Report - 2026-04-25 PR8 MTS Suffixes

Command:

```bash
cargo run --quiet --manifest-path /Users/kawowl/project/negentropy-labs/negentropy/Cargo.toml -- analyze . --format both
```

Exit code: `2`

The scan completed and produced a report. The non-zero exit code reflects the
reported high overall risk.

## Summary

- Tool version: `0.1.0`
- Files scanned: `167`
- Modules: `167`
- Overall risk: `High`
- Extensions: `.cjs`, `.js`, `.jsx`, `.mjs`, `.mts`, `.ts`, `.tsx`

## Dimensions

| Dimension | Metric | Raw | Previous Raw | Risk |
| --- | --- | ---: | ---: | --- |
| module_abstraction | IIE | `0.008` | `0.008` | Low |
| logic_cohesion | EAD | `2.0` | `2.0` | Medium |
| change_blast_radius | TCR | `0.006` | `0.006` | Low |
| architecture_decoupling | TCE | `0.006` | `0.006` | Low |
| testability_pluggability | EDR | `0.85` | `0.85` | Low |
| intent_redundancy | PLME | `0.0` | `0.0` | Low |
| state_encapsulation | SSE+OA | `{"oa":0.044,"sse":1.644}` | `{"oa":0.044,"sse":1.644}` | High |

## Refactor Impact

- Renamed non-JSX TypeScript source, tests, scripts, and config from `.ts` to `.mts`.
- Left React component files as `.tsx` and kept the generated Vite declaration file as `.d.ts`.
- Updated package `imports`/`exports`/`main`/`types` entries to point at `.mts` sources.
- Updated server scripts and drizzle-kit commands to use `.mts`, including explicit `--config drizzle.config.mts`.
- Updated `scripts/check-esm.mjs` to reject runtime `.ts` files while allowing `.d.ts`.
- Current suffix distribution: `127` `.mts`, `37` `.tsx`, `1` `.d.ts`, `0` runtime `.ts`, `0` `.cts`, `0` `.cjs`.
- Negentropy metrics are stable; the reported hotspots are now the same entities with `.mts` paths.

## Current Top Hotspots

- `apps/server/src/routes/mcp.mts::handler`: high external attribute reads.
- `packages/core/src/game-session.mts::anonymous@712`: high external attribute reads.
- `apps/server/src/routes/sessions.mts::open`: high external attribute reads.
- `packages/core/src/schemas.mts`: high interface-to-implementation ratio.
- `apps/server/src/db/schema.mts`: high interface-to-implementation ratio.
- `packages/core/src/architect/injection-rule-generator.mts`: high interface-to-implementation ratio.
- `apps/server/src/__tests__/playthrough-service.test.mts`: high mutable declaration expansion.
- `apps/server/src/__tests__/narrative-reader.test.mts`: high mutable declaration expansion.
- `packages/core/src/__tests__/narration-cut.test.mts`: high mutable declaration expansion.

## Verification

- `pnpm check:esm`
- `pnpm check`
- `pnpm typecheck:tsc`
- `pnpm test:server`
- `pnpm test:core`
- `pnpm build`
- `pnpm --filter @ivn/server db:check`
- `bun --cwd apps/server -e "console.log(import.meta.resolve('#internal/app')); console.log(import.meta.resolve('#internal/db')); console.log(import.meta.resolve('#scripts/seed-admin'))"`
- `bun --cwd packages/core -e "console.log(import.meta.resolve('#internal/game-session')); console.log(import.meta.resolve('@ivn/core/types'))"`
- `bun --cwd packages/specification -e "console.log(import.meta.resolve('#internal/env'))"`
- `bun --cwd apps/ui -e "console.log(import.meta.resolve('#internal/ui/App')); console.log(import.meta.resolve('#internal/lib/utils'))"`
- `rg --files apps packages scripts -g '*.ts' -g '!*.d.ts'`
- `git diff --check`

## Follow-up Refactor Targets

- Split MCP route tool-call branches into named command handlers.
- Extract `apps/server/src/routes/sessions.mts::open` into smaller request parsing, playthrough loading, and session boot helpers.
- Continue the `packages/core/src/game-session.mts` callback extraction around step tracing and batch assignment.
- Consider replacing the remaining historical `.ts` references in comments/docs where they are not intentionally historical.
