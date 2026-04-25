# Core Loop Evaluation Architecture

Date: 2026-04-25

## Goal

Interactive-novel memory strategies need repeatable evaluation runs that do not depend on the browser UI. The core loop should accept inputs, produce observable outputs, and let each runtime decide how to render or persist those outputs.

This pass keeps the existing `SessionEmitter` contract but treats it explicitly as a core output port:

- `GameSession` owns orchestration: generate, parse narrative output, wait for player input, persist runtime milestones.
- UI transport is one consumer: `WebSocketSessionEmitter` serializes output events to the browser.
- Evaluation is another consumer: `createRecordingSessionEmitter` records status, streaming text, sentences, scene changes, tool calls, debug snapshots, and input requests without WebSocket or Zustand.
- Future ivn-xml consumers should subscribe to `Sentence` and `SceneState` output, then project them into their own view protocol.

## Current Slice

The first refactor deliberately avoids a large rewrite:

- Added `RecordingSessionEmitter` as a pure backend/evaluation consumer.
- Clarified `SessionEmitter` documentation so it is no longer described as a frontend UI interface.
- Extracted `GameSession` orchestration helpers:
  - `beginGenerateTurn`
  - `createTurnTools`
  - `createNarrativeRuntime`
  - `runReceivePhase`
- Kept parser internals and ordered stream side effects imperative, because chunk order and event emission are the point of that code.

The intended reading shape is:

1. `coreLoop` reads like the chapter outline: begin generate, call tools/LLM, parse output, finish generate, then receive input.
2. Narrative parser details live under `createNarrativeRuntime`.
3. Player-input waiting and persistence details live under `runReceivePhase`.
4. Recording/evaluation output is implemented as a consumer, not as UI state.

## Next Refactor Steps

- Split generate orchestration into a `GenerateTurnRuntime` module once tests cover more of the LLM callback behavior.
- Rename or supersede `SessionEmitter` with a more explicit `CoreLoopOutputPort` / event ADT after both WebSocket and recording consumers are stable.
- Build a memory-evaluation harness around `createRecordingSessionEmitter`, scripted input sequences, and deterministic LLM fixtures.
- Add an ivn-xml projection layer that consumes `Sentence` / `SceneState` instead of reading UI store state.

## Repository Notes

- `GameSession` is still the largest orchestration hotspot. The useful next split is generate-turn preparation and completion, not parser micro-refactors.
- Parser v2 already has the right core shape: pure reducer plus a small streaming adapter. Keep that pattern as the north star.
- Evaluation code should depend on core outputs and persistence ports, not on `apps/ui` stores or WebSocket message shapes.
