# Negentropy Report — Readback Sentences Restore

Date: 2026-04-26

Command:

```bash
rm -rf /tmp/ivn-negentropy-readback
rsync -a --delete --exclude '.git' --exclude 'node_modules' --exclude '.claude/worktrees' --exclude '.env' --exclude '.env.*' ./ /tmp/ivn-negentropy-readback/
negentropy analyze /tmp/ivn-negentropy-readback \
  --format json \
  --fail-on none \
  --baseline /Users/kawowl/project/github.com/KawOwl/IVNEditor/docs/refactor/negentropy-json/negentropy-2026-04-26-remove-legacy-runtime.json \
  --output /Users/kawowl/project/github.com/KawOwl/IVNEditor/docs/refactor/negentropy-json/negentropy-2026-04-26-readback-sentences-restore.json
```

Why the mirror: the working tree currently has local `.claude/worktrees` content
that should not be part of project-level architecture scoring.

Summary:

- Files scanned: 240
- Modules: 240
- Overall risk: medium

Delta vs `negentropy-2026-04-26-remove-legacy-runtime.json`:

- No risk-level changes.
- `module_abstraction` raw: `0.016 -> 0.013` (`-0.003`)
- `logic_cohesion` raw: unchanged at `2.0`
- `testability_pluggability` raw: `0.874 -> 0.875` (`+0.001`)
- `state_encapsulation.oa`: `0.060 -> 0.074` (`+0.014`)
- `state_encapsulation.sse`: unchanged at `1.500`
- New hotspots: none
- Resolved hotspots: none

Change context:

- Added current-protocol readback from `narrative_entries` to `Sentence[]`.
- Kept V1 historical readback as a read-only boundary.
- Changed WS restore and paginated history readback to send server-projected
  `sentences` instead of raw entries.
- Removed the frontend restore path that reparsed every generate entry with the
  V1 parser.
