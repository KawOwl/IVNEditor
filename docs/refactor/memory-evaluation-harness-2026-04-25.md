# Memory Evaluation Harness

Date: 2026-04-25

## What Landed

Added a core-side deterministic harness at:

- `packages/core/src/evaluation/memory-harness.mts`

The harness wires together:

- `createRecordingSessionEmitter` for observable core-loop output.
- `GenerateTurnRuntime` for the actual generate-phase behavior.
- The real tool executor, so scripted tool calls still update state, scene, and
  pending input through normal runtime callbacks.
- The real memory factory and memory adapters.
- An in-memory `SessionPersistence` plus `NarrativeHistoryReader`, so legacy and
  llm-summarizer adapters read canonical `narrative_entries`-shaped history just
  like server runtime does.
- A deterministic scripted LLM fixture for generate turns and summarizer
  compression calls.

This is intentionally not a browser E2E harness and not a live model benchmark.
It is the repeatable core-loop layer that lets memory configs be compared before
spending real provider calls.

## Evaluation Shape

Call `runMemoryEvaluationSuite` with:

- a scenario: prompt segments, state schema, tools, protocol, and scene assets
- one or more memory variants: `MemoryConfig` plus optional custom memory factory
- a scripted generate/input sequence
- optional deterministic compression responses

The report returns:

- full recorded session output
- in-memory persistence entries and lifecycle traces
- final memory snapshot
- final state and scene
- a compact comparison row per memory variant
- scripted LLM call observations, including compression call count

The first test exercises `legacy` and `llm-summarizer` with the same two-turn
script and verifies that both produce comparable input requests while
`llm-summarizer` consumes the deterministic compression response.

## DeepSeek Note

The harness added in this slice does not call live DeepSeek. When a future
server-side or CLI eval runner is allowed to use the real DeepSeek config, keep
thinking disabled until the thinking-mode response/replay format is adapted:

```ts
{
  thinkingEnabled: false,
  reasoningEffort: null,
}
```

Do not enable thinking for these memory eval runs yet.
