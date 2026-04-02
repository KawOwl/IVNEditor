/**
 * WebSocketSessionEmitter — SessionEmitter 的 WebSocket 实现
 *
 * 将 GameSession 的事件序列化为 JSON 通过 WebSocket 推送到前端。
 * 玩家模式下不推送 debug 数据（含完整 prompt / 剧本内容）。
 */

import type { SessionEmitter, SessionStatus, DebugSnapshot } from '../../src/core/session-emitter';
import type { PromptSnapshot, ToolCallEntry } from '../../src/core/types';

type WS = { send(data: string): void };

export function createWebSocketEmitter(ws: WS): SessionEmitter {
  function emit(type: string, payload?: unknown) {
    try {
      ws.send(JSON.stringify({ type, ...payload as any }));
    } catch {
      // WebSocket might be closed
    }
  }

  return {
    // --- Lifecycle ---
    reset() {
      emit('reset');
    },

    setStatus(status: SessionStatus) {
      emit('status', { status });
    },

    setError(error: string | null) {
      emit('error', { error });
    },

    // --- Streaming ---
    appendTextChunk(text: string) {
      emit('text-chunk', { text });
    },

    appendReasoningChunk(text: string) {
      emit('reasoning-chunk', { text });
    },

    finalizeStreaming() {
      emit('finalize');
    },

    // --- Entries ---
    appendEntry(entry: { role: 'generate' | 'receive' | 'system'; content: string }) {
      emit('entry', { entry });
    },

    // --- Tool calls (player sees tool names + results, not internal details) ---
    addToolCall(entry: Omit<ToolCallEntry, 'timestamp'>) {
      emit('tool-call', { name: entry.name, args: entry.args });
    },

    addPendingToolCall(entry: Omit<ToolCallEntry, 'timestamp'>) {
      emit('pending-tool-call', { name: entry.name, args: entry.args });
    },

    updateToolResult(name: string, result: unknown) {
      emit('tool-result', { name, result });
    },

    updatePendingToolResult(name: string, result: unknown) {
      emit('pending-tool-result', { name, result });
    },

    // --- Input ---
    setInputHint(hint: string | null) {
      emit('input-hint', { hint });
    },

    setInputType(type: 'freetext' | 'choice', choices?: string[] | null) {
      emit('input-type', { inputType: type, choices });
    },

    // --- Debug (NOT sent to player — keeps script content secret) ---
    stagePendingDebug(_info: { promptSnapshot?: PromptSnapshot; finishReason?: string }) {
      // noop for player mode
    },

    updateDebug(_debug: DebugSnapshot) {
      // noop for player mode
    },
  };
}
