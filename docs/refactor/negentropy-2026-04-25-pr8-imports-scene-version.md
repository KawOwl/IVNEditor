# Negentropy Report - 2026-04-25 PR8 Imports, Scene, Version History

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
| testability_pluggability | EDR | `0.85` | `0.852` | Low |
| intent_redundancy | PLME | `0.453` | `0.667` | Medium |
| state_encapsulation | SSE+OA | `{"oa":0.044,"sse":1.644}` | `{"oa":0.044,"sse":1.644}` | High |

## Refactor Impact

- Server `src` routes/services/db imports now use `#server/*` package imports for internal server package boundaries.
- `apps/server/src/db/index.ts -> ../env` and the `apps/server/src/routes/assets.ts` service/auth relative imports are no longer top hotspots.
- `apps/ui/src/ui/editor/VersionHistoryList.tsx::anonymous@93` is no longer a top hotspot after extracting `VersionHistoryItem`.
- `packages/core/src/game-session/scene-state.ts::applyScenePatchToState` is no longer a top hotspot after splitting full-scene and single-sprite patch helpers.
- `intent_redundancy` improved from `0.667` to `0.453`; it remains `Medium`.
- Overall risk remains `High`, still driven by state encapsulation and large route/session/game-session projections.

## Current Top Hotspots

- `apps/server/src/routes/auth.ts`: relative import to `../auth`.
- `apps/ui/src/stores/__tests__/game-store-catchup.test.ts`: relative import to `../game-store`.
- `apps/ui/src/ui/App.tsx`: relative import to `../stores/app-store`.
- `apps/server/src/routes/mcp.ts::handler`: high external attribute reads.
- `packages/core/src/game-session.ts::anonymous@710`: high external attribute reads.
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
- `bun --cwd apps/server -e "await import('#server/env'); await import('#server/auth-identity'); await import('#server/session-manager'); await import('#server/services/script-service'); console.log('server imports resolved')"`
- `git diff --check`

## Follow-up Refactor Targets

- Add a `#server/auth` import target or otherwise decide whether legacy password auth should stay in server root.
- Move UI app/store imports behind `#ui/*` or a narrower store import alias.
- Split MCP route tool-call branches into named command handlers.
- Extract `apps/server/src/routes/sessions.ts::open` into smaller request parsing, playthrough loading, and session boot helpers.
- Continue reducing state encapsulation hotspots by extracting mutable test setup builders.
