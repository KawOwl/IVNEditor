# Core Loop Evaluation Architecture

Date: 2026-04-25

## Goal

Interactive-novel memory strategies need repeatable evaluation runs that do not depend on the browser UI. The core loop should accept inputs, produce observable outputs, and let each runtime decide how to render or persist those outputs.

This pass keeps the existing `SessionEmitter` contract but treats it explicitly as a core output port:

- `GameSession` owns session orchestration: start, restore, stop, generate phase, scenario finish check, and receive phase.
- `GenerateTurnRuntime` owns generate orchestration: prepare context, call LLM, parse narrative output, persist generate milestones, and compact memory.
- UI transport is one consumer: `WebSocketSessionEmitter` serializes output events to the browser.
- Evaluation is another consumer: `createRecordingSessionEmitter` records status, streaming text, sentences, scene changes, tool calls, debug snapshots, and input requests without WebSocket or Zustand.
- Future ivn-xml consumers should subscribe to `Sentence` and `SceneState` output, then project them into their own view protocol.

## Current Slices

The first refactor deliberately avoided a large rewrite:

- Added `RecordingSessionEmitter` as a pure backend/evaluation consumer.
- Clarified `SessionEmitter` documentation so it is no longer described as a frontend UI interface.
- Extracted `GameSession` orchestration helpers:
  - `beginGenerateTurn`
  - `createTurnTools`
  - `createNarrativeRuntime`
  - `runReceivePhase`
- Kept parser internals and ordered stream side effects imperative, because chunk order and event emission are the point of that code.

The second refactor moves generate-phase state into `GenerateTurnRuntime`:

- `GameSession.coreLoop` now reads as: begin generate, run generate phase, finish scenario if needed, then receive input.
- `GenerateTurnRuntime` owns turn-scoped buffers, the current LLM step batch id, parser runtime, scene patch emitter, abort controller, and pending signal recording.
- `GameSession` receives only the final `currentScene` and `pendingSignal` from the runtime, so player input still belongs to the receive phase.
- A runtime-level test runs a deterministic LLM double through one generate turn and verifies streaming output, sentence output, memory observation, and persistence callbacks.

The intended reading shape is:

1. `coreLoop` reads like the chapter outline: begin generate, run generate, finish scenario, then receive input.
2. Generate turn details live under `GenerateTurnRuntime`.
3. Narrative parser details live under `GenerateTurnRuntime.createNarrativeRuntime`.
4. Recording/evaluation output is implemented as a consumer, not as UI state.

## Next Refactor Steps

- Split `GenerateTurnRuntime` internally once more if it starts growing in competing directions: context preparation, LLM callbacks, persistence completion, and narrative runtime are the likely internal sections.
- Rename or supersede `SessionEmitter` with a more explicit `CoreLoopOutputPort` / event ADT after both WebSocket and recording consumers are stable.
- Build a memory-evaluation harness around `createRecordingSessionEmitter`, scripted input sequences, and deterministic LLM fixtures.
- Add an ivn-xml projection layer that consumes `Sentence` / `SceneState` instead of reading UI store state.

## Repository Notes

- `GameSession` is now primarily session orchestration. The next hotspot to watch is `GenerateTurnRuntime`, but its state is at least scoped to one turn.
- Parser v2 already has the right core shape: pure reducer plus a small streaming adapter. Keep that pattern as the north star.
- Evaluation code should depend on core outputs and persistence ports, not on `apps/ui` stores or WebSocket message shapes.
