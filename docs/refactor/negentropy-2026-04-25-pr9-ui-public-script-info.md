# Negentropy Report - 2026-04-25 PR9 UI Public Script Info

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
| module_abstraction | IIE | `0.009` | `0.008` | Low |
| logic_cohesion | EAD | `2.0` | `2.0` | Medium |
| change_blast_radius | TCR | `0.006` | `0.006` | Low |
| architecture_decoupling | TCE | `0.006` | `0.006` | Low |
| testability_pluggability | EDR | `0.847` | `0.848` | Low |
| intent_redundancy | PLME | `0.0` | `0.0` | Low |
| state_encapsulation | SSE+OA | `{"oa":0.043,"sse":1.707}` | `{"oa":0.043,"sse":1.707}` | High |

## Refactor Impact

- Moved the public script info projection out of `App.tsx` and into
  `apps/ui/src/ui/play/public-script-info.mts`.
- Exported the `PublicScriptInfo` UI contract next to the projection that turns
  it into the pseudo `ScriptManifest` used by `PlayPage`.
- Split the projection into smaller factories for the remote stub chapter and
  memory config.
- Removed `apps/ui/src/ui/App.tsx::publicInfoToManifest` from the current
  negentropy hotspot list without introducing a replacement hotspot in the new
  adapter module.
- File/module count rose from `167` to `168`; `module_abstraction` IIE moved
  from `0.008` to `0.009` and remains `Low`.

## Current Top Hotspots

- `apps/ui/src/stores/ws-message-handlers.mts::handleSessionMessage`: high external attribute reads.
- `apps/ui/src/ui/architect/ResultPreview.tsx::anonymous@166`: high external attribute reads.
- `apps/ui/src/ui/play/vn/DialogBox.tsx::renderBody`: high external attribute reads.
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

- Continue PR9 with `apps/ui/src/stores/ws-message-handlers.mts::handleSessionMessage`.
- Consider splitting `apps/ui/src/ui/architect/ResultPreview.tsx::anonymous@166`
  after the planned WS message handler pass.
- Consider extracting `apps/ui/src/ui/play/vn/DialogBox.tsx::renderBody` into
  body-specific render helpers after the current PR9 sequence.
