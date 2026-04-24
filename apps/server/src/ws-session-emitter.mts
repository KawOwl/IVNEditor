/**
 * WebSocketSessionEmitter — SessionEmitter 的 WebSocket 实现
 *
 * 将 GameSession 的事件序列化为 JSON 通过 WebSocket 推送到前端。
 *
 * enableDebug 控制是否推送 debug 数据（完整 prompt snapshot / 调试面板等）：
 *   - 玩家正式游玩（kind='production'）→ false，避免泄漏剧本内容
 *   - 编剧试玩（kind='playtest'）→ true，编辑器需要看到 prompt 上下文
 */

import type { SessionEmitter, SessionStatus, DebugSnapshot } from '@ivn/core/session-emitter';
import type { PromptSnapshot, ToolCallEntry, SceneState, Sentence } from '@ivn/core/types';

type WS = { send(data: string): void };

export function createWebSocketEmitter(
  ws: WS,
  options?: { enableDebug?: boolean },
): SessionEmitter {
  const debug = options?.enableDebug ?? false;
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
    beginStreamingEntry() {
      emit('begin-streaming');
      return ''; // client manages IDs independently
    },

    appendToStreamingEntry(text: string) {
      emit('text-chunk', { text });
    },

    appendReasoningToStreamingEntry(reasoning: string) {
      emit('reasoning-chunk', { text: reasoning });
    },

    finalizeStreamingEntry() {
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

    // --- Debug ---
    // 只在 enableDebug=true（编剧试玩）时推送，避免泄漏剧本内容给玩家。
    stagePendingDebug(info: { promptSnapshot?: PromptSnapshot; finishReason?: string }) {
      if (!debug) return;
      emit('stage-pending-debug', { promptSnapshot: info.promptSnapshot, finishReason: info.finishReason });
    },

    updateDebug(snapshot: DebugSnapshot) {
      if (!debug) return;
      emit('update-debug', snapshot);
    },

    // --- VN Narrative & Scene (M3) ---
    appendSentence(sentence: Sentence) {
      emit('sentence', { sentence });
    },

    emitSceneChange(scene: SceneState, transition?: 'fade' | 'cut' | 'dissolve') {
      emit('scene-change', { scene, transition });
    },
  };
}
