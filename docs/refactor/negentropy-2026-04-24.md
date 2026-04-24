# Negentropy Report - 2026-04-24

Command:

```bash
cargo run --quiet --manifest-path /Users/kawowl/project/negentropy-labs/negentropy/Cargo.toml -- analyze . --format both
```

Exit code: `2`

The scan completed and produced a report. The non-zero exit code reflects the
reported high overall risk.

## Summary

- Tool version: `0.1.0`
- Files scanned: `165`
- Modules: `165`
- Overall risk: `High`
- Extensions: `.cjs`, `.js`, `.jsx`, `.mjs`, `.mts`, `.ts`, `.tsx`

## Dimensions

| Dimension | Metric | Raw | Risk |
| --- | --- | ---: | --- |
| module_abstraction | IIE | `0.008` | Low |
| logic_cohesion | EAD | `2.0` | Medium |
| change_blast_radius | TCR | `0.006` | Low |
| architecture_decoupling | TCE | `0.006` | Low |
| testability_pluggability | EDR | `0.859` | Low |
| intent_redundancy | PLME | `1.348` | High |
| state_encapsulation | SSE+OA | `{"oa":0.041,"sse":1.667}` | High |

## Top Hotspots

- `apps/ui/src/fixtures/module7-test.ts`: deep relative imports to scenario Markdown files.
- `apps/ui/src/ui/editor/EditorDebugPanel.tsx::SentenceRow`: high external attribute reads.
- `scripts/verify-xml-narrative.ts::scoreOutput`: high external attribute reads.
- `apps/ui/src/stores/ws-client-emitter.ts::handleMessage`: high external attribute reads.
- `packages/core/src/schemas.ts`: high interface-to-implementation ratio.
- `apps/server/src/db/schema.ts`: high interface-to-implementation ratio.
- `packages/core/src/architect/injection-rule-generator.ts`: high interface-to-implementation ratio.
- `apps/server/src/__tests__/playthrough-service.test.ts`: high mutable declaration expansion.
- `apps/server/src/__tests__/narrative-reader.test.ts`: high mutable declaration expansion.
- `packages/core/src/__tests__/narration-cut.test.ts`: high mutable declaration expansion.

## Follow-up Refactor Targets

- Replace deep relative fixture imports with a stable fixture alias or package-level asset boundary.
- Continue splitting `EditorDebugPanel` and move row formatting/derived projections out of render components.
- Split `ws-client-emitter` message handling into typed event handlers.
- Revisit schema-heavy files after the monorepo split settles, especially public schema ownership between `core` and `specification`.
