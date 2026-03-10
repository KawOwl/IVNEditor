/**
 * Debug Store - Centralized state for the Debug Drawer.
 * Aggregates data from workflow steps, agent traces, and game state.
 */

import { create } from 'zustand';
import type { Goal5W1H, GOAPAction, EpisodicMemory, WorldEvent, SceneOutput } from '../memory/schemas';

export type GamePhase =
  | 'idle'
  | 'assemble'
  | 'cognition'
  | 'goap'
  | 'goap_gen'
  | 'timeline'
  | 'director'
  | 'render'
  | 'reflection'
  | 'waiting_input'
  | 'error';

export interface AgentTrace {
  agent: string;
  duration: number;
  inputTokens: number;
  outputTokens: number;
  timestamp: number;
}

export interface DebugState {
  // Core loop phase
  phase: GamePhase;
  phaseStartedAt: number;
  loopCount: number;

  // 5W1H result
  currentGoal: Goal5W1H | null;
  goalRawJson: string;

  // GOAP queue
  goapQueue: Array<{
    action: GOAPAction;
    status: 'pending' | 'running' | 'done' | 'interrupted';
  }>;
  goapTotalTime: number;

  // Memory context
  memoryContext: {
    recalledCount: number;
    totalTokens: number;
    personaShiftCount: number;
    recalledItems: EpisodicMemory[];
  };

  // Timeline
  timeline: {
    currentTime: string;
    goalEndTime: string;
    upcomingEvents: Array<{ time: string; event: string; conflict: boolean }>;
  };

  // Agent traces
  traces: AgentTrace[];

  // Current scenes being rendered
  currentScenes: SceneOutput[];

  // Error log
  errors: Array<{ message: string; timestamp: number }>;

  // Actions
  setPhase: (phase: GamePhase) => void;
  setCurrentGoal: (goal: Goal5W1H, rawJson: string) => void;
  setGoapQueue: (actions: GOAPAction[], totalTime: number) => void;
  updateGoapStatus: (index: number, status: 'pending' | 'running' | 'done' | 'interrupted') => void;
  setMemoryContext: (ctx: DebugState['memoryContext']) => void;
  setTimeline: (tl: DebugState['timeline']) => void;
  pushTrace: (trace: AgentTrace) => void;
  setScenes: (scenes: SceneOutput[]) => void;
  pushError: (message: string) => void;
  incrementLoop: () => void;
  reset: () => void;
}

export const useDebugStore = create<DebugState>()((set) => ({
  phase: 'idle',
  phaseStartedAt: 0,
  loopCount: 0,
  currentGoal: null,
  goalRawJson: '',
  goapQueue: [],
  goapTotalTime: 0,
  memoryContext: { recalledCount: 0, totalTokens: 0, personaShiftCount: 0, recalledItems: [] },
  timeline: { currentTime: '08:00', goalEndTime: '', upcomingEvents: [] },
  traces: [],
  currentScenes: [],
  errors: [],

  setPhase: (phase) =>
    set({ phase, phaseStartedAt: Date.now() }),

  setCurrentGoal: (goal, rawJson) =>
    set({ currentGoal: goal, goalRawJson: rawJson }),

  setGoapQueue: (actions, totalTime) =>
    set({
      goapQueue: actions.map((a) => ({ action: a, status: 'pending' as const })),
      goapTotalTime: totalTime,
    }),

  updateGoapStatus: (index, status) =>
    set((s) => {
      const queue = [...s.goapQueue];
      if (queue[index]) queue[index] = { ...queue[index], status };
      return { goapQueue: queue };
    }),

  setMemoryContext: (ctx) => set({ memoryContext: ctx }),

  setTimeline: (tl) => set({ timeline: tl }),

  pushTrace: (trace) =>
    set((s) => ({ traces: [...s.traces.slice(-19), trace] })),

  setScenes: (scenes) => set({ currentScenes: scenes }),

  pushError: (message) =>
    set((s) => ({
      errors: [...s.errors.slice(-9), { message, timestamp: Date.now() }],
      phase: 'error' as GamePhase,
    })),

  incrementLoop: () =>
    set((s) => ({ loopCount: s.loopCount + 1 })),

  reset: () =>
    set({
      phase: 'idle',
      phaseStartedAt: 0,
      loopCount: 0,
      currentGoal: null,
      goalRawJson: '',
      goapQueue: [],
      goapTotalTime: 0,
      memoryContext: { recalledCount: 0, totalTokens: 0, personaShiftCount: 0, recalledItems: [] },
      traces: [],
      currentScenes: [],
      errors: [],
    }),
}));
