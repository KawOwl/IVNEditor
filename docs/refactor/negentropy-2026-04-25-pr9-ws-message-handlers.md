# Negentropy Report - 2026-04-25 PR9 WS Message Handlers

Command:

```bash
cargo run --quiet --manifest-path /Users/kawowl/project/negentropy-labs/negentropy/Cargo.toml -- analyze . --format both
```

Exit code: `2`

The scan completed and produced a report. The non-zero exit code reflects the
reported high overall risk.

## Summary

- Tool version: `0.1.0`
- Files scanned: `168`
- Modules: `168`
- Overall risk: `High`
- Extensions: `.cjs`, `.js`, `.jsx`, `.mjs`, `.mts`, `.ts`, `.tsx`

## Dimensions

| Dimension | Metric | Raw | Previous Raw | Risk |
| --- | --- | ---: | ---: | --- |
| module_abstraction | IIE | `0.009` | `0.009` | Low |
| logic_cohesion | EAD | `2.0` | `2.0` | Medium |
| change_blast_radius | TCR | `0.006` | `0.006` | Low |
| architecture_decoupling | TCE | `0.006` | `0.006` | Low |
| testability_pluggability | EDR | `0.847` | `0.847` | Low |
| intent_redundancy | PLME | `0.0` | `0.0` | Low |
| state_encapsulation | SSE+OA | `{"oa":0.043,"sse":1.707}` | `{"oa":0.043,"sse":1.707}` | High |

## Refactor Impact

- Replaced the top-level `handleSessionMessage` switch with a
  `SESSION_MESSAGE_HANDLERS` dispatch table.
- Moved each handled WebSocket message type into a named handler function.
- Extracted tool-call and scene-change message projections into small helpers.
- Left ignored/legacy message types as implicit no-ops, matching the previous
  switch behavior.
- Removed `apps/ui/src/stores/ws-message-handlers.mts::handleSessionMessage`
  from the current negentropy hotspot list without introducing replacement WS
  handler hotspots.

## Current Top Hotspots

- `apps/ui/src/ui/architect/ResultPreview.tsx::anonymous@166`: high external attribute reads.
- `apps/ui/src/ui/play/vn/DialogBox.tsx::renderBody`: high external attribute reads.
- `apps/ui/src/ui/play/vn/useDialogTypewriter.mts::useDialogTypewriter`: high external attribute reads.
- `packages/core/src/schemas.mts`: high interface-to-implementation ratio.
- `apps/server/src/db/schema.mts`: high interface-to-implementation ratio.
- `packages/core/src/architect/injection-rule-generator.mts`: high interface-to-implementation ratio.
- `apps/server/src/__tests__/playthrough-service.test.mts`: high mutable declaration expansion.
- `apps/server/src/__tests__/narrative-reader.test.mts`: high mutable declaration expansion.
- `packages/core/src/__tests__/narration-cut.test.mts`: high mutable declaration expansion.

## Verification

- `pnpm check`
- `pnpm typecheck:tsc`
- `pnpm build`
- `git diff --check`

## Follow-up Refactor Targets

- Decide whether PR9 should stop here, since the planned three-item sequence is
  complete.
- If continuing the hotspot sweep, start with
  `apps/ui/src/ui/architect/ResultPreview.tsx::anonymous@166`.
- Then consider `DialogBox.tsx::renderBody` and
  `useDialogTypewriter.mts::useDialogTypewriter`.
