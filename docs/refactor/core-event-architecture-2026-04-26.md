# CoreEvent Architecture Status

Date: 2026-04-26

Branch: `codex/code-quality-refactor`

## Current Shape

```text
GameSession
  -> GenerateTurnRuntime
  -> CoreEvent
       -> durable-first SessionPersistenceCoreEventSink
       -> WebSocketCoreEventSink
       -> RecordingSessionOutputSink
       -> RecordingCoreEventSink
       -> CoreEventLogSink
```

The runtime no longer depends on the legacy `SessionEmitter` interface for live
output or persistence. `SessionEmitter` is now a compatibility projection used
by historical golden comparison tests. Historical V1 playthroughs are read back
through the dedicated `legacy-v1-readback` boundary.

## Runtime Flow

```text
start / restore
  -> session-started | session-restored

generate
  -> generate-turn-started
  -> context-assembled
  -> assistant-message-started
  -> llm-step-started
  -> assistant deltas / tool calls / narrative batches
  -> signal-input-recorded?
  -> assistant-message-finalized
  -> narrative-segment-finalized
  -> generate-turn-completed

receive
  -> waiting-input-started
  -> player-input-recorded
```

Durable events are interpreted by `SessionPersistenceCoreEventSink` and flushed
before realtime projection consumers observe them when the durable-first sink is
used.

## Completed

- `GameSession` and `GenerateTurnRuntime` emit CoreEvents as the primary output.
- `SessionPersistence` is now interpreted from CoreEvents instead of being
  called directly from runtime code.
- WebSocket output is now a direct CoreEvent sink with the same JSON wire format
  as before.
- Evaluation and runtime tests record `RecordedSessionOutput` directly from
  CoreEvents via `RecordingSessionOutputSink`; the legacy projection remains as
  a golden compatibility comparison.
- `tool-call-finished` carries both `input` and `output`, so persistence does
  not infer tool payloads from external state.
- The memory evaluation harness runs persistence through the CoreEvent path.
- The protocol validator checks:
  - terminal state boundaries
  - assistant start/finalize/generate-complete ordering
  - signal waiting causality
  - tool start/finish pairing
  - main batch membership
  - player request/payload consistency
- A durable event-log sink, replay helper, and restore-state reducer exist in
  core. The server now persists CoreEvent envelopes per playthrough and uses
  them on session open to derive the restore/continue point before falling back
  to historical narrative-entry recovery.
- Historical `v1-tool-call` playthroughs have a readonly readback boundary that
  reconstructs Sentence streams from old narrative/tool entries without running
  the engine or using SessionEmitter projection.
- Deprecated SessionEmitter projection aliases and public GameSession barrel
  exports have been removed; the remaining projection is explicitly legacy and
  internal to compatibility checks.
- Negentropy JSON reports are now chained with `--baseline` for each refactor
  step.

## Remaining

- Keep event-log restore as the preferred runtime recovery path; historical
  playthroughs without CoreEvent logs continue through narrative-entry fallback.
- Keep expanding validator coverage only when a real timing invariant appears;
  avoid making it a duplicate runtime implementation.

## Merge Risk Notes

The highest-risk timing paths now have explicit events and tests:

- `signal_input_needed` is represented as `signal-input-recorded` followed by
  `waiting-input-started`.
- Narrative persistence uses `narrative-segment-finalized` with its own
  `batchId`; it no longer reads a mutable current batch from outside the event.
- Player input persistence uses `player-input-recorded` with payload and
  snapshot together.
- WebSocket messages are projected directly from CoreEvents, with a golden
  sequence test preserving the existing client wire protocol.

The remaining live compatibility risk is not the core event stream itself; it is
whether any UI consumer had an undocumented dependency on a legacy WebSocket
message side effect outside the tested wire sequence.
