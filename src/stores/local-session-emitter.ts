/**
 * LocalSessionEmitter — SessionEmitter 的本地实现
 *
 * 直接写 Zustand GameStore，用于前端单体模式。
 * 未来替换为 WebSocket 实现时，此文件是唯一需要替换的。
 */

import { useGameStore } from './game-store';
import type { SessionEmitter, SessionStatus, DebugSnapshot } from '../core/session-emitter';
import type { PromptSnapshot, ToolCallEntry } from './game-store';

export function createLocalEmitter(): SessionEmitter {
  // 获取 store — Zustand 的 getState() 在 React 外也可用
  const store = () => useGameStore.getState();

  return {
    // --- Lifecycle ---
    reset() {
      store().reset();
    },

    setStatus(status: SessionStatus) {
      store().setStatus(status);
    },

    setError(error: string | null) {
      store().setError(error);
    },

    // --- Streaming ---
    appendTextChunk(text: string) {
      store().appendStreamingChunk(text);
    },

    appendReasoningChunk(text: string) {
      store().appendReasoningChunk(text);
    },

    finalizeStreaming() {
      store().finalizeStreaming();
    },

    // --- Entries ---
    appendEntry(entry: { role: 'generate' | 'receive' | 'system'; content: string }) {
      store().appendEntry(entry);
    },

    // --- Tool calls ---
    addToolCall(entry: Omit<ToolCallEntry, 'timestamp'>) {
      store().addToolCall(entry);
    },

    addPendingToolCall(entry: Omit<ToolCallEntry, 'timestamp'>) {
      store().addPendingToolCall(entry);
    },

    updateToolResult(name: string, result: unknown) {
      const calls = store().toolCalls;
      const lastCall = [...calls].reverse().find(
        (c) => c.name === name && c.result === undefined,
      );
      if (lastCall) {
        lastCall.result = result;
      }
    },

    updatePendingToolResult(name: string, result: unknown) {
      const pending = store().pendingToolCalls;
      const lastPending = [...pending].reverse().find(
        (c) => c.name === name && c.result === undefined,
      );
      if (lastPending) {
        lastPending.result = result;
      }
    },

    // --- Input ---
    setInputHint(hint: string | null) {
      store().setInputHint(hint);
    },

    setInputType(type: 'freetext' | 'choice', choices?: string[] | null) {
      store().setInputType(type, choices);
    },

    // --- Debug ---
    stagePendingDebug(info: { promptSnapshot?: PromptSnapshot; finishReason?: string }) {
      store().stagePendingDebug(info);
    },

    updateDebug(debug: DebugSnapshot) {
      store().updateDebug(debug);
    },
  };
}
