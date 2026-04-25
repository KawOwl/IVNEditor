# Handoff - GenerateTurnRuntime and E2E

Date: 2026-04-25

Branch: `codex/code-quality-refactor`

Latest commits at handoff:

- `2fce1a5 refactor: split generate turn runtime`
- `98902a4 refactor: add core loop evaluation output port`

## Conversation Starting Point

User approved this direction:

```ts
const turnRuntime = createGenerateTurnRuntime(deps);

const prepared = await turnRuntime.prepare(turn);
const result = await turnRuntime.generate(prepared);
await turnRuntime.complete(result);
```

The agreed design standard:

- `GenerateTurnRuntime` should represent only one generate turn lifecycle.
- It is not the global session.
- It does not handle player input.
- It prepares context, runs LLM generate, finalizes narrative output, persists the generate result, compacts memory, and syncs debug state.
- `GameSession` should read like orchestration prose:

```ts
while (this.active) {
  const turn = await this.beginGenerateTurn();
  const generateResult = await this.runGeneratePhase(turn);
  if (generateResult.stopped) break;

  if (await this.finishScenarioIfNeeded()) break;

  await this.runReceivePhase(turn);
}
```

The user also set the code style target:

- Code should read like a novel at the orchestration layer.
- Details should be organized like a wiki: each layer keeps one abstraction level, and lower-level details live behind named helper functions.
- Prefer immutable/data-transform style where clearer, but keep streaming parser, async iterator, and explicit side-effect state machines imperative where event order is the business rule.

## Implemented Slice

Main implementation commit: `2fce1a5 refactor: split generate turn runtime`

Files changed:

- `packages/core/src/game-session.mts`
- `packages/core/src/game-session/generate-turn-runtime.mts`
- `packages/core/src/__tests__/generate-turn-runtime.test.mts`
- `docs/refactor/coreloop-evaluation-architecture.md`
- `docs/refactor/negentropy-2026-04-25-generate-turn-runtime.md`

What changed:

- Moved generate-phase orchestration and turn-scoped mutable state out of `GameSession`.
- Added `GenerateTurnRuntime`, owning:
  - `currentNarrativeBuffer`
  - `currentReasoningBuffer`
  - `currentStepBatchId`
  - parser runtime
  - scene patch emitter
  - pending signal recording
  - abort controller
- `GameSession` now owns session-level lifecycle:
  - start / restore / stop
  - begin generate turn
  - run generate phase
  - scenario finish check
  - receive phase
- `stop()` now aborts the active generate runtime instead of holding a session-level abort controller.
- A stopped-during-preparation guard was added so an aborted turn does not open an empty streaming entry or call the LLM.

## Tests and Checks

Passed before commit:

```bash
pnpm check:esm
pnpm typecheck
pnpm test:core
negentropy analyze . --format json --fail-on none --output /tmp/ivn-negentropy-generate-turn-runtime-2026-04-25.json
git diff --check
```

Core tests at that point:

- `252 pass`
- `0 fail`
- `751 expect() calls`

Negentropy summary recorded in `docs/refactor/negentropy-2026-04-25-generate-turn-runtime.md`:

- Overall risk: `High`
- `module_abstraction`: Low
- `logic_cohesion`: Medium
- `change_blast_radius`: Low
- `architecture_decoupling`: Low
- `testability_pluggability`: Low
- `intent_redundancy`: Low
- `state_encapsulation`: High

## E2E Run Notes

Dev services used:

```bash
pnpm dev:all
```

Observed ports:

- UI: `http://localhost:5174/`
- Server: `http://localhost:3001`

The initial browser tab at `http://127.0.0.1:5175/` was stale because nothing was listening on port `5175`.

Seeded the E2E script:

```bash
cd apps/server
ADMIN_USERS="e2e_admin:<random-password>" bun --env-file=../../.env run scripts/seed-admin.mts
bun --env-file=../../.env run scripts/seed-test-e2e.mts
```

This created/used:

- Admin user: `e2e_admin`
- Script id: `test-e2e-library`
- Title: `E2E 测试 · 图书馆奇遇`
- Published version id seen during the run: `44d77f33-38a0-411a-b59f-2ed05475a6c1`

Important env note:

- Root `.env` had `DATABASE_URL`.
- Real LLM config was in `apps/server/.env`.
- The user later added a real DeepSeek config there.

The DB `llm_configs` row was updated from env with thinking disabled:

```ts
{
  provider: env.LLM_PROVIDER,
  baseUrl: env.LLM_BASE_URL,
  apiKey: env.LLM_API_KEY,
  model: env.LLM_MODEL,
  name: env.LLM_NAME,
  thinkingEnabled: false,
  reasoningEffort: null,
}
```

Reason: DeepSeek new thinking mode data format is not adapted yet, so thinking must stay disabled for now.

Real LLM config observed:

- Provider: `openai-compatible`
- Base URL: `https://api.deepseek.com/v1`
- Model: `deepseek-v4-flash`
- Name: `deepseek`

E2E browser flow succeeded with real DeepSeek:

1. Published catalog showed `E2E 测试 · 图书馆奇遇`.
2. New playthrough was created.
3. WebSocket connected.
4. First generate turn succeeded.
5. `change_scene` rendered `hall`.
6. Jenkins `neutral` sprite appeared.
7. `signal_input_needed` produced choice input.
8. Submitted `【测试】直接进入书架深处`.
9. The next generate turn switched to chapter 2.
10. Scene changed to `deep_stacks`.
11. Luna appeared, then changed from `reading` / `look_up` to `smile` in the next interaction.
12. Another receive/generate/signal loop completed successfully.

Latest checked playthrough snapshot:

- Playthrough id prefix: `db01f000`
- Status: `waiting-input`
- Turn: `3`
- Current scene:

```json
{
  "background": "deep_stacks",
  "sprites": [{ "id": "luna", "emotion": "smile" }]
}
```

State vars:

```json
{
  "chapter": 2,
  "met_luna": true,
  "knows_secret": false,
  "current_scene": "deep_stacks",
  "trust_jenkins": 0
}
```

Entries:

- `entryCount`: `16`
- Recent entries included `player_input`, `tool_call`, `narrative`, and `signal_input`.
- Batch grouping looked healthy: narrative and signal input for a turn shared the same main batch id.

Minor E2E observation:

- The model did not set `knows_secret=true` even after a Luna/book reveal style interaction.
- This looks like prompt/seed behavior, not a `GenerateTurnRuntime` regression.

## Temporary Mock LLM Note

A local OpenAI-compatible mock LLM was briefly used while diagnosing the invalid placeholder DeepSeek key.

- Mock port: `39001`
- It was stopped before returning to real LLM validation.
- At handoff, `lsof -nP -iTCP:39001 -sTCP:LISTEN` should return nothing.

## Current Local Runtime State

At the end of E2E, the app was still running locally:

- Server process listened on `3001`.
- Vite UI process listened on `5174`.

Restart command if needed:

```bash
pnpm dev:all
```

## Next Useful Work

Near-term:

- Keep DeepSeek thinking disabled until the new thinking-mode response/replay format is implemented.
- Add a durable env/bootstrap path so `llm_configs` can be refreshed from env without one-off eval commands.
- Strengthen `seed-test-e2e` or its prompt so the Luna reveal reliably updates `knows_secret=true`.
- Add a browser E2E script/harness for:
  - catalog appears
  - new playthrough
  - first signal input
  - chapter switch to `deep_stacks`
  - restore after reload

Architecture:

- Build the memory evaluation harness around `createRecordingSessionEmitter`, scripted inputs, and swappable memory configs.
- Do not split parser internals just for style; parser event order is the business rule.
- If `GenerateTurnRuntime` grows further, split by responsibility:
  - context preparation
  - LLM callback adapter
  - narrative runtime
  - persistence completion
  - debug/tracing sync

## Commands Worth Reusing

Run core checks:

```bash
pnpm check:esm
pnpm typecheck
pnpm test:core
```

Run negentropy:

```bash
negentropy analyze . --format json --fail-on none --output /tmp/ivn-negentropy-$(date +%Y-%m-%d).json
```

Seed E2E script:

```bash
cd apps/server
bun --env-file=../../.env run scripts/seed-test-e2e.mts
```

Update DB LLM config from `apps/server/.env` with thinking disabled:

```bash
cd apps/server
bun --env-file=.env --eval "
import { getServerEnv } from '#internal/env';
import { llmConfigService } from '#internal/services/llm-config-service';
import { closePool } from '#internal/db';
const env = getServerEnv();
const configs = await llmConfigService.listAll();
for (const cfg of configs) {
  await llmConfigService.update(cfg.id, {
    provider: env.LLM_PROVIDER,
    baseUrl: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    model: env.LLM_MODEL,
    name: env.LLM_NAME,
    thinkingEnabled: false,
    reasoningEffort: null,
  });
}
await closePool();
process.exit(0);
"
```
