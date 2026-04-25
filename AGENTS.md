# AGENTS.md — Shared Agent Rules

This file is the shared working agreement for Claude, Codex, and any future
coding agent in this repository. Read it before making changes, then follow any
agent-specific files such as `CLAUDE.md`.

---

## Core Posture

- Work in small, verifiable steps.
- Prefer existing package boundaries and local patterns over new abstractions.
- Keep changes scoped to the task unless a wider change is required for safety.
- Preserve user changes. Never revert unrelated work.
- Commit meaningful completed units rather than accumulating large batches.

---

## Code Style

Prefer **pure core, imperative shell**.

Use immutable data assembly for:

- mapping API or DB rows into view models
- building arrays, maps, markdown sections, and payload objects
- filtering, grouping, and de-duplicating collections
- deriving UI presenter models
- constructing prompt sections, memory summaries, and protocol payloads

Prefer `map`, `filter`, `flatMap`, `reduce`, `Object.fromEntries`, array spread,
`Promise.all`, and small named projection helpers when they make the data
transformation easier to read.

Keep imperative code when order and local state are the point:

- streaming parsers
- async iterators and backpressure-sensitive flows
- transaction sequences
- tool-call stacks
- parser buffers
- retry/finally cleanup
- token-budget trimming with early exit

Readability beats functional cleverness. Use iterator style only when it names
the transformation better than a loop.

---

## Parser And Runtime Style

For parser-like or stream-like code, prefer this shape:

```ts
type Step = (
  state: ParserState,
  event: ParserEvent,
) => {
  state: ParserState;
  outputs: ParserOutput[];
};
```

The pure reducer should not perform IO, mutate external state, or call UI/DB
adapters. A thin runtime adapter may hold the current state and interpret the
outputs.

Good local references:

- `packages/core/src/narrative-parser-v2/reducer.mts`
- `packages/core/src/narrative-parser-v2/state.mts`
- `packages/core/src/narrative-parser-v2/index.mts`
- `packages/core/src/game-session/scene-state.mts`

Do not force parser reducers, streaming accumulators, or ordered state machines
into clever `reduce` chains when an explicit state transition is clearer.

---

## Side Effects

Isolate side effects behind narrow capabilities.

Prefer:

- pure payload builders before DB/network calls
- interface-injected capabilities over direct singleton imports in reusable code
- adapters for DB, tracing, S3, LLM, WebSocket, browser, or filesystem work
- explicit event/command/output types at boundaries

Current project boundaries:

- Core session logic depends on `SessionPersistence`, `CoreEventSink`, and
  `SessionTracing` interfaces.
- `SessionEmitter` is a legacy projection target for WebSocket, recording, and
  existing UI/debug consumers. New core runtime code should emit `CoreEvent`
  and use a projection adapter when legacy emitter output is required.
- Server-side DB persistence is implemented in
  `apps/server/src/services/playthrough-persistence.mts`.
- Parser v2 keeps pure reducer logic separate from the htmlparser2 streaming
  adapter.

If introducing an effect system such as Effect-TS, start at side-effect-heavy
boundaries like persistence, tracing, LLM calls, S3 uploads, or session
lifecycle orchestration. Do not introduce it merely to make pure data transforms
look more functional.

---

## Package Boundaries

This repository is an ESM-only pnpm workspace.

- `apps/ui` owns React UI and browser-local orchestration.
- `apps/server` owns HTTP/WebSocket routes, DB access, and server adapters.
- `packages/core` owns engine logic, parser logic, memory contracts, protocol
  projections, and reusable pure/runtime abstractions.
- `packages/specification` owns shared protocol/specification assets.

Use package exports/import aliases instead of deep cross-package relative
imports. Avoid `../../../` package boundary escapes.

---

## Verification

Choose verification proportional to the change:

- Type/API/package-boundary changes: `pnpm typecheck`
- ESM/import changes: `pnpm check:esm`
- Core logic/parser/memory changes: `pnpm test:core`
- Server DB/session changes: `bun --env-file ../../.env test` from `apps/server`
- UI changes: run the UI and inspect the relevant flow in the browser

For commits in this refactor line, run negentropy before committing. Save the
machine-readable JSON under `docs/refactor/negentropy-json/` and include a
human-readable report under `docs/refactor/`. The CLI is installed system-wide
as `negentropy`:

```bash
negentropy analyze . --format json --fail-on none --output docs/refactor/negentropy-json/negentropy-YYYY-MM-DD-slug.json
```

Common variants (pick one based on what you want to see):

- Full machine-readable JSON for archive and future baselines:
  `negentropy analyze . --format json --fail-on none --output docs/refactor/negentropy-json/negentropy-YYYY-MM-DD-slug.json`
- Delta against the previous committed JSON report:
  `negentropy analyze . --format json --fail-on none --baseline docs/refactor/negentropy-json/negentropy-YYYY-MM-DD-previous-slug.json --output docs/refactor/negentropy-json/negentropy-YYYY-MM-DD-slug.json`
- Quick top-N hotspot table while iterating:
  `negentropy analyze . --format table --fail-on none --top 10`
- Both at once (terminal table + JSON file): drop `--output` and use
  `--format both`.

Flags worth knowing: `--top N` (default 3) for hotspot count;
`--extensions .ts,.tsx,.mts` to scope the scan; `--fail-on
none|medium|high` to control whether the run exits non-zero. Existing high
negentropy risk does not block a commit when the scan is run with
`--fail-on none`, but new hotspots should be investigated.

When a baseline JSON exists, prefer `--baseline <previous-json>` and mention the
dimension changes, `new_hotspots`, and `resolved_hotspots` in the markdown
report. The previous JSON should normally be the latest committed file under
`docs/refactor/negentropy-json/`.

Historical reports under `docs/refactor/` may show the older
`cargo run --manifest-path /Users/kawowl/project/negentropy-labs/...` form;
that's a record of how the scan was run at the time and stays as-is. New
reports should use the `negentropy` command directly.

---

## Commit Discipline

- Commit message format: `type: concise description`.
- Common types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`.
- Before committing, confirm the worktree only contains intended files.
- Do not commit secrets. `.env` is local runtime configuration and should not be
  modified or included.
- If merging a working branch back to `main`, merge only after the branch is
  clean and verified.
