# Negentropy Report: CoreEvent Log Sequence Documentation

Date: 2026-04-26

Branch: `codex/code-quality-refactor`

## Change Summary

- Added a dedicated design note for the CoreEvent log sequence allocation race
  found by browser E2E.
- Linked the ordering note from the CoreEvent architecture status document.

## Verification

```bash
git diff --check
negentropy analyze . --format json --fail-on none --baseline docs/refactor/negentropy-json/negentropy-2026-04-26-core-event-log-sequence-allocation.json --output docs/refactor/negentropy-json/negentropy-2026-04-26-core-event-log-sequence-doc.json
```

Results:

- Diff whitespace check: pass
- Negentropy: exit 0 with `--fail-on none`

## Negentropy Summary

Source JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-core-event-log-sequence-doc.json`

Baseline JSON:

- `docs/refactor/negentropy-json/negentropy-2026-04-26-core-event-log-sequence-allocation.json`

Summary:

- Tool version: `0.1.0`
- Files scanned: 235
- Modules: 235
- Overall risk: medium
- Medium dimensions: `logic_cohesion`, `state_encapsulation`

Delta:

- All dimension raw values unchanged from baseline.
- `new_hotspots`: none
- `resolved_hotspots`: none
