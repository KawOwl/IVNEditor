# Negentropy Report - 2026-04-25 PR8 Sessions Open

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
| module_abstraction | IIE | `0.008` | `0.008` | Low |
| logic_cohesion | EAD | `2.0` | `2.0` | Medium |
| change_blast_radius | TCR | `0.006` | `0.006` | Low |
| architecture_decoupling | TCE | `0.006` | `0.006` | Low |
| testability_pluggability | EDR | `0.851` | `0.85` | Low |
| intent_redundancy | PLME | `0.0` | `0.0` | Low |
| state_encapsulation | SSE+OA | `{"oa":0.044,"sse":1.69}` | `{"oa":0.044,"sse":1.69}` | High |

## Refactor Impact

- Split `apps/server/src/routes/sessions.mts::open` into request parsing,
  session context loading, LLM config projection, wrapper attach, connected
  message send, and restore handling.
- Kept the original WebSocket error messages, close behavior, connected payload,
  restored payload, and wrapper restore snapshot semantics unchanged.
- Replaced repeated restored payload property reads with declarative field lists:
  `RESTORED_CLIENT_FIELDS` and `RESTORE_WRAPPER_FIELDS`.
- Removed `apps/server/src/routes/sessions.mts::open` from the current negentropy
  hotspot list.
- Overall risk remains `High`. With this hotspot removed, the next surfaced
  server route hotspot is `apps/server/src/routes/mcp.mts::handler` at the
  `add_background_to_script` tool.

## Current Top Hotspots

- `packages/core/src/game-session.mts::anonymous@712`: high external attribute reads.
- `apps/ui/src/ui/App.tsx::publicInfoToManifest`: high external attribute reads.
- `apps/server/src/routes/mcp.mts::handler` at `add_background_to_script`: high external attribute reads.
- `packages/core/src/schemas.mts`: high interface-to-implementation ratio.
- `apps/server/src/db/schema.mts`: high interface-to-implementation ratio.
- `packages/core/src/architect/injection-rule-generator.mts`: high interface-to-implementation ratio.
- `apps/server/src/__tests__/playthrough-service.test.mts`: high mutable declaration expansion.
- `apps/server/src/__tests__/narrative-reader.test.mts`: high mutable declaration expansion.
- `packages/core/src/__tests__/narration-cut.test.mts`: high mutable declaration expansion.

## Verification

- `pnpm check`
- `pnpm typecheck:tsc`
- `pnpm test:server`
- `pnpm build`
- `git diff --check`

## Follow-up Refactor Targets

- Continue the planned `packages/core/src/game-session.mts` callback extraction
  around step tracing and batch assignment.
- Split the surfaced `add_background_to_script` MCP handler into the same style
  of named command helpers used by `add_character_sprite`.
- Consider whether `apps/ui/src/ui/App.tsx::publicInfoToManifest` should move
  into a dedicated UI adapter module after the originally planned route/core
  hotspots are handled.
