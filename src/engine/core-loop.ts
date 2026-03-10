/**
 * Core Game Loop - Orchestrates the full cognition -> action -> narrative cycle.
 *
 * Steps:
 * ① Context assembly (ContextEngine.assemble)
 * ② 5W1H cognitive reasoning (Cognition Agent)
 * ③ GOAP action planning
 * ④ Timeline conflict detection
 * ⑤ Narrative generation (Director Agent)
 * ⑥ Render scenes
 * ⑦ Player input injection (if intervention mode)
 * ⑧ Post-processing (ContextEngine.afterTurn)
 * ⑨ Auto-pause check (if autoPauseOnTaskDone)
 */

import { NovelContextEngine } from '../memory/context-engine';
import type { AssembleResult, AgentMessage } from '../memory/context-engine';
import { useCharacterStore } from '../memory/character-store';
import { runCognition } from '../agents/cognition';
import { runDirector } from '../agents/director';
import { generateGoapAction } from '../agents/goap-generator';
import { planActions, mapGoalToGOAPState } from '../goap/planner';
import { Timeline } from '../timeline/timeline';
import { useDebugStore } from '../debug/debug-store';
import { usePlayerStore } from '../player/player-store';
import type { GOAPAction, SceneOutput, WorldEvent, Goal5W1H } from '../memory/schemas';

export interface CoreLoopConfig {
  characterId: string;
  contextEngine: NovelContextEngine;
  timeline: Timeline;
  goapActions: GOAPAction[];
  onScenesReady: (scenes: SceneOutput[]) => void;
  onLoopComplete: () => void;
  onError: (error: Error) => void;
}

export class CoreLoop {
  private config: CoreLoopConfig;
  private running = false;
  private paused = false;
  private sessionId: string;

  constructor(config: CoreLoopConfig) {
    this.config = config;
    this.sessionId = `novel:${config.characterId}`;
  }

  async start() {
    this.running = true;
    const debug = useDebugStore.getState();

    // Bootstrap
    await this.config.contextEngine.bootstrap({
      sessionId: this.sessionId,
      sessionFile: `memory/${this.config.characterId}.session.json`,
    });

    // Run loop
    while (this.running) {
      if (this.paused) {
        await this.sleep(100);
        continue;
      }

      // ⑦ Check intervention mode: wait for player input
      const playerState = usePlayerStore.getState();
      if (playerState.mode === 'intervention' && !playerState.pendingMessage) {
        debug.setPhase('waiting_input');
        await this.sleep(200);
        continue;
      }

      try {
        await this.runOneCycle();
        debug.incrementLoop();
        this.config.onLoopComplete();
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        debug.pushError(err.message);
        this.config.onError(err);
        // Wait before retrying
        await this.sleep(3000);
      }
    }
  }

  stop() {
    this.running = false;
  }

  pause() {
    this.paused = true;
    useDebugStore.getState().setPhase('idle');
  }

  resume() {
    this.paused = false;
  }

  isPaused() {
    return this.paused;
  }

  private async runOneCycle(): Promise<void> {
    const { contextEngine, timeline, goapActions, characterId } = this.config;
    const debug = useDebugStore.getState();
    const charStore = useCharacterStore.getState();
    const persona = charStore.getPersona(characterId);
    if (!persona) throw new Error(`Character ${characterId} not found`);

    // Consume pending player message (if any)
    const playerStore = usePlayerStore.getState();
    const playerMessage = playerStore.consumePendingMessage();
    const injectMessages: AgentMessage[] = [];

    if (playerMessage) {
      // Ingest player message as episodic memory
      await contextEngine.ingest({
        sessionId: this.sessionId,
        message: { role: 'user', content: playerMessage },
      });
      // Include in this cycle's context assembly
      injectMessages.push({ role: 'user', content: playerMessage });
      // Add to chat as system acknowledgement
      playerStore.addSystemMessage(`[已注入] "${playerMessage}"`);
    }

    // ① Context assembly
    debug.setPhase('assemble');
    const worldState = timeline.buildWorldState(
      'town-square',
      ['guard-captain'],
      this.describeSituation(timeline),
    );

    const assembled: AssembleResult = await contextEngine.assemble({
      sessionId: this.sessionId,
      messages: injectMessages,
      tokenBudget: 8000,
    });

    debug.setMemoryContext({
      recalledCount: assembled.metadata?.recalledMemories?.length ?? 0,
      totalTokens: assembled.estimatedTokens,
      personaShiftCount: assembled.metadata?.personaShifts?.length ?? 0,
      recalledItems: assembled.metadata?.recalledMemories ?? [],
    });

    // ② Cognition Agent: 5W1H reasoning
    debug.setPhase('cognition');
    const cognitionResult = await runCognition(assembled);
    const goal: Goal5W1H = cognitionResult.goal;

    debug.setCurrentGoal(goal, cognitionResult.rawResponse);
    debug.pushTrace({
      agent: 'cognition',
      duration: cognitionResult.durationMs,
      inputTokens: cognitionResult.inputTokens,
      outputTokens: cognitionResult.outputTokens,
      timestamp: Date.now(),
    });

    // Store the goal
    charStore.addShortTermGoal(characterId, goal);

    // Ingest the goal decision as a memory
    await contextEngine.ingest({
      sessionId: this.sessionId,
      message: {
        role: 'assistant',
        content: `[决策] ${goal.what}。原因：${goal.why}。地点：${goal.where}`,
      },
    });

    // ②½ Dynamic GOAP generation (if enabled and player message exists)
    if (playerMessage && playerStore.dynamicGoapEnabled) {
      debug.setPhase('goap_gen');
      try {
        const goapGenResult = await generateGoapAction(
          playerMessage,
          goapActions,
          goal,
        );
        if (goapGenResult.action) {
          goapActions.push(goapGenResult.action);
          playerStore.addSystemMessage(
            `[动态动作] 已生成新动作：${goapGenResult.action.name}`,
          );
        }
        debug.pushTrace({
          agent: 'goap-gen',
          duration: goapGenResult.durationMs,
          inputTokens: 0,
          outputTokens: 0,
          timestamp: Date.now(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        debug.pushError(`动态GOAP生成失败: ${msg}`);
      }
    }

    // ③ GOAP planning
    debug.setPhase('goap');
    const goalState = mapGoalToGOAPState(goal.what, goal.where);
    const plan = planActions({}, goalState, goapActions);

    if (!plan || plan.actions.length === 0) {
      // Fallback: create a simple "go and do" plan
      const fallbackAction: GOAPAction = {
        id: 'custom-action',
        name: goal.what,
        preconditions: {},
        effects: goalState,
        cost: 2,
        timeCost: 30,
        description: goal.how[0] ?? goal.what,
      };
      debug.setGoapQueue([fallbackAction], 30);
      await this.executeAction(fallbackAction, goal, persona, undefined, false);

      // ⑨ Auto-pause after task
      this.checkAutoPause();
    } else {
      debug.setGoapQueue(plan.actions, plan.totalTime);

      // ④ Timeline conflict detection
      debug.setPhase('timeline');
      const conflict = timeline.checkConflict(plan.totalTime);

      // Update timeline debug
      const upcoming = timeline.getUpcoming();
      debug.setTimeline({
        currentTime: timeline.formatTime(),
        goalEndTime: timeline.formatTime(timeline.getCurrentTime() + plan.totalTime),
        upcomingEvents: upcoming.map((e) => ({
          time: timeline.formatTime(e.time),
          event: e.name,
          conflict: e.time <= timeline.getCurrentTime() + plan.totalTime,
        })),
      });

      if (conflict) {
        // Interrupted! Advance to event, then handle
        await this.handleInterrupt(plan.actions, goal, persona, conflict);
      } else {
        // Execute all actions sequentially
        for (let i = 0; i < plan.actions.length; i++) {
          debug.updateGoapStatus(i, 'running');
          await this.executeAction(plan.actions[i], goal, persona, undefined, false);
          debug.updateGoapStatus(i, 'done');

          // ⑨ Auto-pause after each GOAP task
          this.checkAutoPause();

          // If paused during execution, wait
          while (this.paused && this.running) {
            await this.sleep(100);
          }
        }
        // Advance time
        timeline.advance(plan.totalTime);
      }
    }

    // ⑧ Post-processing
    debug.setPhase('idle');
    await contextEngine.afterTurn({
      sessionId: this.sessionId,
      sessionFile: `memory/${characterId}.session.json`,
      messages: [],
      prePromptMessageCount: 0,
    });

    // Update timeline display
    debug.setTimeline({
      currentTime: timeline.formatTime(),
      goalEndTime: '',
      upcomingEvents: timeline.getUpcoming().map((e) => ({
        time: timeline.formatTime(e.time),
        event: e.name,
        conflict: false,
      })),
    });

    // Small delay between cycles for readability
    await this.sleep(2000);
  }

  /**
   * Check if we should auto-pause after a GOAP task completes.
   * This switches the player to intervention mode.
   */
  private checkAutoPause() {
    const playerState = usePlayerStore.getState();
    if (playerState.autoPauseOnTaskDone) {
      playerState.setMode('intervention');
      useDebugStore.getState().setPhase('waiting_input');
    }
  }

  private async handleInterrupt(
    actions: GOAPAction[],
    goal: Goal5W1H,
    persona: NonNullable<ReturnType<typeof useCharacterStore.getState.prototype.getPersona>>,
    event: WorldEvent,
  ) {
    const debug = useDebugStore.getState();
    const { contextEngine, timeline, characterId } = this.config;

    // Mark remaining actions as interrupted
    for (let i = 0; i < actions.length; i++) {
      debug.updateGoapStatus(i, 'interrupted');
    }

    // Advance time to event
    timeline.advance(event.time - timeline.getCurrentTime());

    // Ingest the world event as a memory
    await contextEngine.ingest({
      sessionId: this.sessionId,
      message: {
        role: 'system',
        content: `[世界事件] ${event.name}：${event.description}（地点：${event.location}）`,
      },
    });

    // Mark current goal as interrupted
    const charStore = useCharacterStore.getState();
    const goals = charStore.getGoals(characterId);
    const activeIndex = goals.shortTerm.findIndex((g) => g.status === 'active');
    if (activeIndex >= 0) {
      charStore.updateShortTermGoalStatus(characterId, activeIndex, 'interrupted');
    }

    // Generate narrative for the interruption
    debug.setPhase('director');
    const directorResult = await runDirector({
      characterPersona: persona,
      currentGoal: goal,
      action: {
        id: 'interrupted',
        name: '被突发事件打断',
        preconditions: {},
        effects: {},
        cost: 0,
        timeCost: 0,
        description: `${event.name}：${event.description}`,
      },
      worldEvent: event,
      interrupted: true,
    });

    debug.pushTrace({
      agent: 'director',
      duration: directorResult.durationMs,
      inputTokens: directorResult.inputTokens,
      outputTokens: directorResult.outputTokens,
      timestamp: Date.now(),
    });

    debug.setScenes(directorResult.scenes);
    this.config.onScenesReady(directorResult.scenes);

    // Add to player chat
    const playerStore = usePlayerStore.getState();
    for (const scene of directorResult.scenes) {
      if (scene.speaker) {
        playerStore.addCharacterMessage(scene.speaker, scene.dialogue);
      } else {
        playerStore.addNarratorMessage(scene.dialogue);
      }
    }

    // Ingest narrative as memory
    for (const scene of directorResult.scenes) {
      await contextEngine.ingest({
        sessionId: this.sessionId,
        message: {
          role: 'assistant',
          content: scene.narration
            ? `${scene.narration} ${scene.speaker ? `${scene.speaker}："${scene.dialogue}"` : scene.dialogue}`
            : scene.dialogue,
        },
      });
    }

    await this.sleep(3000);
  }

  private async executeAction(
    action: GOAPAction,
    goal: Goal5W1H,
    persona: NonNullable<ReturnType<typeof useCharacterStore.getState.prototype.getPersona>>,
    worldEvent: WorldEvent | undefined,
    interrupted: boolean,
  ) {
    const debug = useDebugStore.getState();
    const { contextEngine } = this.config;

    // ⑤ Director Agent: narrative generation
    debug.setPhase('director');
    const directorResult = await runDirector({
      characterPersona: persona,
      currentGoal: goal,
      action,
      worldEvent,
      interrupted,
    });

    debug.pushTrace({
      agent: 'director',
      duration: directorResult.durationMs,
      inputTokens: directorResult.inputTokens,
      outputTokens: directorResult.outputTokens,
      timestamp: Date.now(),
    });

    // ⑥ Render
    debug.setPhase('render');
    debug.setScenes(directorResult.scenes);
    this.config.onScenesReady(directorResult.scenes);

    // Add to player chat history
    const playerStore = usePlayerStore.getState();
    for (const scene of directorResult.scenes) {
      if (scene.speaker) {
        playerStore.addCharacterMessage(scene.speaker, scene.dialogue);
      } else {
        playerStore.addNarratorMessage(scene.dialogue);
      }
    }

    // Ingest narrative as memory
    for (const scene of directorResult.scenes) {
      await contextEngine.ingest({
        sessionId: this.sessionId,
        message: {
          role: 'assistant',
          content: scene.narration
            ? `${scene.narration} ${scene.speaker ? `${scene.speaker}："${scene.dialogue}"` : scene.dialogue}`
            : scene.dialogue,
        },
      });
    }

    // Pause to let player read
    await this.sleep(2000);
  }

  private describeSituation(timeline: Timeline): string {
    const active = timeline.getActiveEvents();
    if (active.length > 0) {
      return active.map((e) => e.description).join('；');
    }
    return `${timeline.formatTime()}，一切如常。`;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
