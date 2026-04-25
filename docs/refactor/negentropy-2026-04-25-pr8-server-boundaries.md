# Negentropy Report - 2026-04-25 PR8 Server Boundaries

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
| module_abstraction | IIE | `0.008` | `0.011` | Low |
| logic_cohesion | EAD | `2.0` | `2.0` | Medium |
| change_blast_radius | TCR | `0.006` | `0.006` | Low |
| architecture_decoupling | TCE | `0.006` | `0.006` | Low |
| testability_pluggability | EDR | `0.852` | `0.854` | Low |
| intent_redundancy | PLME | `0.667` | `0.827` | Medium |
| state_encapsulation | SSE+OA | `{"oa":0.044,"sse":1.644}` | `{"oa":0.044,"sse":1.644}` | High |

## Refactor Impact

- Server scripts now use standard package imports (`#server/*`) instead of `../src/*` paths.
- Server tests now use the same `#server/*` boundary for app/db/auth/services imports.
- `apps/server/src/services/narrative-reader.ts::rowToEntry` is no longer a top hotspot after splitting kind normalization from row projection.
- `apps/ui/src/ui/editor/ScriptInfoPanel.tsx::anonymous@499` is no longer a top hotspot after extracting `CharacterAssetItem`.
- `intent_redundancy` improved from `0.827` to `0.667`; it remains `Medium`.
- Overall risk remains `High`, still driven by state encapsulation and a few large schema/route hotspots.

## Current Top Hotspots

- `apps/server/src/db/index.ts`: deep relative import to `../env`.
- `apps/server/src/routes/assets.ts`: deep relative imports to auth/service modules.
- `apps/server/src/routes/mcp.ts::handler`: high external attribute reads.
- `apps/ui/src/ui/editor/VersionHistoryList.tsx::anonymous@93`: high external attribute reads.
- `packages/core/src/game-session/scene-state.ts::applyScenePatchToState`: high external attribute reads.
- `packages/core/src/schemas.ts`: high interface-to-implementation ratio.
- `apps/server/src/db/schema.ts`: high interface-to-implementation ratio.
- `packages/core/src/architect/injection-rule-generator.ts`: high interface-to-implementation ratio.
- `apps/server/src/__tests__/playthrough-service.test.ts`: high mutable declaration expansion.
- `apps/server/src/__tests__/narrative-reader.test.ts`: high mutable declaration expansion.

## Verification

- `pnpm check`
- `pnpm typecheck:tsc`
- `pnpm test:server`
- `pnpm build`
- `bun -e "console.log(import.meta.resolve('#server/db'))"` from `apps/server`
- `bun -e "console.log(import.meta.resolve('#server/app')); console.log(import.meta.resolve('#server/services/user-service'))"` from `apps/server`
- `pnpm --filter @ivn/server typecheck && pnpm --filter @ivn/server typecheck:tsc && pnpm --filter @ivn/server test` after the final server test import cleanup
- `git diff --check`

## Follow-up Refactor Targets

- Move remaining server `src` internal imports onto `#server/*` where it clarifies package boundaries.
- Split MCP route tool-call branches into named command handlers.
- Extract `VersionHistoryList` row rendering into a small row component/presenter.
- Destructure `applyScenePatchToState` into per-field helpers.
- Start reducing state encapsulation hotspots by extracting mutable test setup builders.
