# Negentropy Report - 2026-04-24 Fixtures And Scoring

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
| testability_pluggability | EDR | `0.86` | `0.86` | Low |
| intent_redundancy | PLME | `1.265` | `1.345` | High |
| state_encapsulation | SSE+OA | `{"oa":0.041,"sse":1.644}` | `{"oa":0.041,"sse":1.644}` | High |

## Refactor Impact

- `apps/ui/src/fixtures/module7-test.ts` raw document imports no longer use four-level relative paths.
- `scripts/verify-xml-narrative.ts::scoreOutput` is no longer a top hotspot after moving scoring into small declarative rules.
- `intent_redundancy` improved from `1.345` to `1.265`.
- Overall risk remains `High`; the remaining top hotspots are mostly path boundary issues, service update normalization, schema-heavy files, and mutable test setup.

## Current Top Hotspots

- `apps/ui/src/ui/play/vn/Backlog.tsx`: deep relative import to `stores/game-store`.
- `apps/ui/src/ui/play/vn/VNStageContainer.tsx`: deep relative import to `stores/game-store`.
- `apps/ui/src/ui/architect/DocumentUpload.tsx`: deep relative import to `stores/architect-store`.
- `apps/server/src/services/llm-config-service.ts::update`: high external attribute reads.
- `apps/ui/src/ui/editor/editor-documents.ts::docToSegment`: high external attribute reads.
- `apps/server/src/services/script-version-service.ts::anonymous@311`: high external attribute reads.
- `packages/core/src/schemas.ts`: high interface-to-implementation ratio.
- `apps/server/src/db/schema.ts`: high interface-to-implementation ratio.
- `packages/core/src/architect/injection-rule-generator.ts`: high interface-to-implementation ratio.
- `apps/server/src/__tests__/playthrough-service.test.ts`: high mutable declaration expansion.

## Follow-up Refactor Targets

- Add stable UI aliases or local barrel boundaries for `stores`, `lib`, and feature modules.
- Normalize LLM config update payloads before service mutation.
- Move `editor-documents.ts::docToSegment` field derivation into pure projection helpers.
- Extract repeated mutable setup in server/core tests into fixture builders.
