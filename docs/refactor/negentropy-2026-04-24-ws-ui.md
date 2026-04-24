# Negentropy Report - 2026-04-24 WS/UI Refactor

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
| module_abstraction | IIE | `0.011` | `0.008` | Low |
| logic_cohesion | EAD | `2.0` | `2.0` | Medium |
| change_blast_radius | TCR | `0.006` | `0.006` | Low |
| architecture_decoupling | TCE | `0.006` | `0.006` | Low |
| testability_pluggability | EDR | `0.86` | `0.859` | Low |
| intent_redundancy | PLME | `1.345` | `1.348` | High |
| state_encapsulation | SSE+OA | `{"oa":0.041,"sse":1.644}` | `{"oa":0.041,"sse":1.667}` | High |

## Refactor Impact

- `apps/ui/src/stores/ws-client-emitter.ts::handleMessage` is no longer a top hotspot after moving message interpretation into `ws-message-handlers.ts`.
- `apps/ui/src/ui/editor/EditorDebugPanel.tsx::SentenceRow` is no longer a top hotspot after moving sentence presentation into `sentence-debug-presenter.ts`.
- The overall risk remains `High`; the remaining top hotspots are now concentrated in fixture import paths, XML narrative scoring, LLM config update normalization, editor document projection, schema-heavy files, and mutable test setup.

## Current Top Hotspots

- `apps/ui/src/fixtures/module7-test.ts`: deep relative imports to scenario Markdown files.
- `scripts/verify-xml-narrative.ts::scoreOutput`: high external attribute reads.
- `apps/server/src/services/llm-config-service.ts::update`: high external attribute reads.
- `apps/ui/src/ui/editor/editor-documents.ts::docToSegment`: high external attribute reads.
- `packages/core/src/schemas.ts`: high interface-to-implementation ratio.
- `apps/server/src/db/schema.ts`: high interface-to-implementation ratio.
- `packages/core/src/architect/injection-rule-generator.ts`: high interface-to-implementation ratio.
- `apps/server/src/__tests__/playthrough-service.test.ts`: high mutable declaration expansion.
- `apps/server/src/__tests__/narrative-reader.test.ts`: high mutable declaration expansion.
- `packages/core/src/__tests__/narration-cut.test.ts`: high mutable declaration expansion.

## Follow-up Refactor Targets

- Replace `MODULE_7` deep raw imports with a Vite alias or a dedicated fixture boundary.
- Split `scripts/verify-xml-narrative.ts::scoreOutput` into declarative score checks.
- Move `editor-documents.ts::docToSegment` field derivation into a pure projection helper.
- Normalize LLM config update payloads before service mutation.
