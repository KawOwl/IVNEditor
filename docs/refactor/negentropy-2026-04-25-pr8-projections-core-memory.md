# Negentropy Report - 2026-04-25 PR8 Projections And Core Memory

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
| module_abstraction | IIE | `0.011` | `0.011` | Low |
| logic_cohesion | EAD | `2.0` | `2.0` | Medium |
| change_blast_radius | TCR | `0.006` | `0.006` | Low |
| architecture_decoupling | TCE | `0.006` | `0.006` | Low |
| testability_pluggability | EDR | `0.854` | `0.859` | Low |
| intent_redundancy | PLME | `0.827` | `0.933` | Medium |
| state_encapsulation | SSE+OA | `{"oa":0.044,"sse":1.644}` | `{"oa":0.044,"sse":1.644}` | High |

## Refactor Impact

- `apps/ui/src/ui/editor/editor-documents.ts::docToSegment` is no longer a top hotspot after destructuring and extracting injection/focus helpers.
- `apps/ui/src/ui/editor/sentence-debug-presenter.ts::toSentenceDebugModel` is no longer a top hotspot after splitting per-kind presenters.
- `apps/server/src/services/script-version-service.ts::anonymous@311` is no longer a top hotspot after extracting `toPublishedCatalogEntry`.
- `packages/core/src/memory/*` deep relative imports to core root modules were replaced with `@ivn/core/*` self-references.
- `intent_redundancy` improved from `0.933` to `0.827`; it remains `Medium`.
- Overall risk remains `High`, driven by state encapsulation plus schema-heavy files.

## Current Top Hotspots

- `apps/server/scripts/bootstrap-drizzle-migrations.ts`: deep relative import to `../src/db`.
- `apps/server/scripts/migrate-player-identity.ts`: deep relative import to `../src/db`.
- `apps/server/scripts/seed-admin.ts`: deep relative import to `../src/db`.
- `apps/server/src/routes/mcp.ts::handler`: high external attribute reads.
- `apps/server/src/services/narrative-reader.ts::rowToEntry`: high external attribute reads.
- `apps/ui/src/ui/editor/ScriptInfoPanel.tsx::anonymous@499`: high external attribute reads.
- `packages/core/src/schemas.ts`: high interface-to-implementation ratio.
- `apps/server/src/db/schema.ts`: high interface-to-implementation ratio.
- `packages/core/src/architect/injection-rule-generator.ts`: high interface-to-implementation ratio.
- `apps/server/src/__tests__/playthrough-service.test.ts`: high mutable declaration expansion.

## Verification

- `pnpm check`
- `pnpm typecheck:tsc`
- `pnpm test:core`
- `pnpm test:server`
- `pnpm build`
- `pnpm --filter @ivn/core typecheck && pnpm --filter @ivn/core typecheck:tsc && pnpm --filter @ivn/core test` after the final core import cleanup
- `git diff --check`

## Follow-up Refactor Targets

- Add a stable server package alias for scripts, or move script DB access behind a script-local helper boundary.
- Split MCP route handler branches into named command handlers.
- Destructure/project `narrative-reader.ts::rowToEntry`.
- Extract `ScriptInfoPanel` asset-list mapping callbacks into named projections.
- Tackle mutable setup hotspots in server/core tests with fixture builders.
