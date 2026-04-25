# Negentropy JSON Reports

This directory stores machine-readable `negentropy analyze` output for refactor
commits. Keep these JSON files committed so the next scan can compare against
the previous report with `--baseline`.

Recommended command:

```bash
negentropy analyze . --format json --fail-on none --baseline docs/refactor/negentropy-json/negentropy-YYYY-MM-DD-previous-slug.json --output docs/refactor/negentropy-json/negentropy-YYYY-MM-DD-current-slug.json
```

If no committed baseline exists yet, omit `--baseline` for the first report.

The matching markdown report under `docs/refactor/` should summarize:

- dimension changes
- `new_hotspots`
- `resolved_hotspots`
- any hotspot movement that matters for the current refactor
