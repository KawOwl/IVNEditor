/**
 * PlayerStore — Manages player interaction state for the hybrid mode.
 *
 * Modes:
 * - autonomous: Core loop runs continuously, player can observe
 * - intervention: Core loop pauses, waits for player input before next cycle
 *
 * Features:
 * - Auto-pause toggle: pause after each GOAP task completes
 * - Chat history: LLM-style message history
 * - Pending message: queued player input to inject into next cognition cycle
 */

import { create } from 'zustand';

export interface ChatMessage {
  id: string;
  role: 'player' | 'narrator' | 'character' | 'system';
  content: string;
  timestamp: number;
}

export interface PlayerState {
  // Mode control
  mode: 'autonomous' | 'intervention';
  autoPauseOnTaskDone: boolean;
  dynamicGoapEnabled: boolean;

  // Message queue
  pendingMessage: string | null;

  // Chat history (displayed in the input area)
  chatHistory: ChatMessage[];

  // Actions
  setMode: (mode: 'autonomous' | 'intervention') => void;
  toggleAutoPause: () => void;
  toggleDynamicGoap: () => void;
  sendMessage: (content: string) => void;
  consumePendingMessage: () => string | null;
  addNarratorMessage: (content: string) => void;
  addCharacterMessage: (speaker: string, content: string) => void;
  addSystemMessage: (content: string) => void;
}

function genId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  mode: 'autonomous',
  autoPauseOnTaskDone: false,
  dynamicGoapEnabled: false,
  pendingMessage: null,
  chatHistory: [],

  setMode: (mode) => {
    set({ mode });
    // Add system message to chat
    const label = mode === 'autonomous' ? '切换到自主运行模式' : '切换到介入模式';
    get().addSystemMessage(label);
  },

  toggleAutoPause: () => {
    const next = !get().autoPauseOnTaskDone;
    set({ autoPauseOnTaskDone: next });
    get().addSystemMessage(next ? '世界事件结束后将等待介入' : '世界事件结束后将继续运行');
  },

  toggleDynamicGoap: () => {
    const next = !get().dynamicGoapEnabled;
    set({ dynamicGoapEnabled: next });
    get().addSystemMessage(next ? '动态动作生成已开启' : '动态动作生成已关闭');
  },

  sendMessage: (content) => {
    const msg: ChatMessage = {
      id: genId(),
      role: 'player',
      content,
      timestamp: Date.now(),
    };
    set((s) => ({
      pendingMessage: content,
      chatHistory: [...s.chatHistory, msg],
    }));
  },

  consumePendingMessage: () => {
    const msg = get().pendingMessage;
    if (msg) set({ pendingMessage: null });
    return msg;
  },

  addNarratorMessage: (content) => {
    const msg: ChatMessage = {
      id: genId(),
      role: 'narrator',
      content,
      timestamp: Date.now(),
    };
    set((s) => ({ chatHistory: [...s.chatHistory, msg] }));
  },

  addCharacterMessage: (speaker, content) => {
    const msg: ChatMessage = {
      id: genId(),
      role: 'character',
      content: `${speaker}：${content}`,
      timestamp: Date.now(),
    };
    set((s) => ({ chatHistory: [...s.chatHistory, msg] }));
  },

  addSystemMessage: (content) => {
    const msg: ChatMessage = {
      id: genId(),
      role: 'system',
      content,
      timestamp: Date.now(),
    };
    set((s) => ({ chatHistory: [...s.chatHistory, msg] }));
  },
}));
