# Negentropy Report - 2026-04-25 Handoff

Command:

```bash
negentropy analyze . --format json --fail-on none --output /tmp/ivn-negentropy-handoff-2026-04-25.json
```

Exit code: `0`

This scan was run before committing the GenerateTurnRuntime handoff notes.
The code surface is unchanged from the previous implementation commit, so the
metrics match the post-runtime-split scan.

## Summary

- Tool version: `0.1.0`
- Files scanned: `181`
- Modules: `181`
- Overall risk: `High`
- Extensions: `.cjs`, `.js`, `.jsx`, `.mjs`, `.mts`, `.ts`, `.tsx`

## Dimensions

| Dimension | Metric | Raw | Risk |
| --- | --- | ---: | --- |
| module_abstraction | IIE | `0.008` | Low |
| logic_cohesion | EAD | `2.0` | Medium |
| change_blast_radius | TCR | `0.0` | Low |
| architecture_decoupling | TCE | `0.0` | Low |
| testability_pluggability | EDR | `0.863` | Low |
| intent_redundancy | PLME | `0.0` | Low |
| state_encapsulation | SSE+OA | `{"oa":0.039,"sse":1.659}` | High |

## Current Top Hotspots

- `apps/ui/src/ui/editor/ScriptInfoPanel.tsx::anonymous@532`: high external
  attribute reads.
- `packages/core/src/narrative-parser-v2/state.mts::concatOutputs`: high
  external attribute reads.
- `apps/ui/src/ui/architect/ResultPreview.tsx::anonymous@166`: high external
  attribute reads.
- `packages/core/src/schemas.mts`: high interface-to-implementation ratio.
- `apps/server/src/db/schema.mts`: high interface-to-implementation ratio.
- `packages/core/src/architect/injection-rule-generator.mts`: high
  interface-to-implementation ratio.
- `apps/server/src/__tests__/playthrough-service.test.mts`: high mutable
  declaration expansion.
- `apps/server/src/__tests__/narrative-reader.test.mts`: high mutable
  declaration expansion.
- `packages/core/src/__tests__/narration-cut.test.mts`: high mutable
  declaration expansion.

## Notes

- No code changed in this handoff commit.
- The attached handoff document records the GenerateTurnRuntime design decision,
  implementation commit, real-LLM E2E result, DeepSeek thinking-mode caveat, and
  next recommended work.
- The next architecture step remains the memory evaluation harness around
  `createRecordingSessionEmitter`.
