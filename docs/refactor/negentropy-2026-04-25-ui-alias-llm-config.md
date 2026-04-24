# Negentropy Report - 2026-04-25 UI Alias And LLM Config Update

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
| testability_pluggability | EDR | `0.859` | `0.86` | Low |
| intent_redundancy | PLME | `0.933` | `1.265` | Medium |
| state_encapsulation | SSE+OA | `{"oa":0.044,"sse":1.644}` | `{"oa":0.041,"sse":1.644}` | High |

## Refactor Impact

- UI imports from shared `stores`, `lib`, and `storage` now use the existing `@/` alias instead of deep relative paths.
- `apps/ui/src/ui/play/vn/Backlog.tsx`, `apps/ui/src/ui/play/vn/VNStageContainer.tsx`, and `apps/ui/src/ui/architect/DocumentUpload.tsx` are no longer top path hotspots.
- `apps/server/src/services/llm-config-service.ts::update` is no longer a top logic cohesion hotspot after extracting patch construction.
- `intent_redundancy` improved from `1.265` (`High`) to `0.933` (`Medium`).
- Overall risk remains `High`, now mainly driven by state encapsulation and schema/test hotspots.

## Current Top Hotspots

- `packages/core/src/memory/__tests__/legacy-memory.test.ts`: deep relative imports to core modules.
- `packages/core/src/memory/legacy/manager.ts`: deep relative import to `tokens`.
- `apps/ui/src/ui/editor/editor-documents.ts::docToSegment`: high external attribute reads.
- `apps/server/src/services/script-version-service.ts::anonymous@311`: high external attribute reads.
- `apps/ui/src/ui/editor/sentence-debug-presenter.ts::toSentenceDebugModel`: high external attribute reads.
- `packages/core/src/schemas.ts`: high interface-to-implementation ratio.
- `apps/server/src/db/schema.ts`: high interface-to-implementation ratio.
- `packages/core/src/architect/injection-rule-generator.ts`: high interface-to-implementation ratio.
- `apps/server/src/__tests__/playthrough-service.test.ts`: high mutable declaration expansion.
- `apps/server/src/__tests__/narrative-reader.test.ts`: high mutable declaration expansion.

## Follow-up Refactor Targets

- Add package-level aliases or local barrels inside `packages/core` for nested memory tests/runtime modules.
- Move `editor-documents.ts::docToSegment` field derivation into pure projection helpers.
- Split `script-version-service` mapping/update callbacks into named projection functions.
- Revisit `sentence-debug-presenter` with per-kind projection helpers so the top dispatcher stays shallow.
- Extract repeated mutable setup in server/core tests into fixture builders.
