# Negentropy Report - 2026-04-25 PR8 Internal Imports

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
| intent_redundancy | PLME | `0.0` | `0.453` | Low |
| state_encapsulation | SSE+OA | `{"oa":0.044,"sse":1.644}` | `{"oa":0.044,"sse":1.644}` | High |

## Refactor Impact

- Added package-scoped private imports with `#internal/*` in server, UI, core, and specification packages.
- Added server script imports with `#scripts/*`.
- Replaced package-internal TS/TSX relative imports with `#internal/*`, including the UI CSS entrypoint import.
- Replaced the legacy server-only `#server/*` alias with the package-neutral `#internal/*` form.
- Extended `scripts/check-esm.mjs` to reject package `src` deep imports, old `#server/*` imports, and relative imports.
- `intent_redundancy` improved from `0.453` to `0.0` and is now `Low`.
- Overall risk remains `High`, driven by state encapsulation and a few large route/session/game-session logic hotspots.

## Current Top Hotspots

- `apps/server/src/routes/mcp.ts::handler`: high external attribute reads.
- `packages/core/src/game-session.ts::anonymous@712`: high external attribute reads.
- `apps/server/src/routes/sessions.ts::open`: high external attribute reads.
- `packages/core/src/schemas.ts`: high interface-to-implementation ratio.
- `apps/server/src/db/schema.ts`: high interface-to-implementation ratio.
- `packages/core/src/architect/injection-rule-generator.ts`: high interface-to-implementation ratio.
- `apps/server/src/__tests__/playthrough-service.test.ts`: high mutable declaration expansion.
- `apps/server/src/__tests__/narrative-reader.test.ts`: high mutable declaration expansion.
- `packages/core/src/__tests__/narration-cut.test.ts`: high mutable declaration expansion.

## Verification

- `pnpm check`
- `pnpm typecheck:tsc`
- `pnpm test:server`
- `pnpm test:core`
- `pnpm build`
- `bun --cwd packages/core -e "console.log(import.meta.resolve('#internal/context-assembler')); console.log(import.meta.resolve('#internal/game-session/types'))"`
- `bun --cwd packages/specification -e "console.log(import.meta.resolve('#internal/env'))"`
- `bun --cwd apps/ui -e "console.log(import.meta.resolve('#internal/ui/App')); console.log(import.meta.resolve('#internal/stores/game-store'))"`
- `bun --cwd apps/server -e "console.log(import.meta.resolve('#internal/app')); console.log(import.meta.resolve('#internal/db')); console.log(import.meta.resolve('#scripts/seed-admin'))"`
- `rg -n "#server|from ['\"]\\.{1,2}/|export .* from ['\"]\\.{1,2}/|import ['\"]\\.{1,2}/|@ivn/[^'\"]*/src/" apps packages --glob '*.{ts,tsx,mts,mjs}'`
- `git diff --check`

## Follow-up Refactor Targets

- Split MCP route tool-call branches into named command handlers.
- Extract `apps/server/src/routes/sessions.ts::open` into smaller request parsing, playthrough loading, and session boot helpers.
- Continue the `packages/core/src/game-session.ts` callback extraction around step tracing and batch assignment.
- Decide when to start `.ts -> .mts` renames now that package-scoped import namespaces are in place.
