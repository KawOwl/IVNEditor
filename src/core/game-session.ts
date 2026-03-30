/**
 * GameSession — 端到端集成层
 *
 * 串联所有核心模块：
 *   StateStore, MemoryManager, ContextAssembler, ToolExecutor,
 *   LLMClient, FlowExecutor → Zustand GameStore
 *
 * 对外只暴露简单的 API：
 *   - start(config): 初始化并开始运行
 *   - submitInput(text): 提交玩家输入
 *   - stop(): 停止
 *
 * 内部通过 FlowExecutor 的 NodeHandlers 回调驱动引擎循环。
 */

import type {
  FlowGraph,
  FlowNode,
  PromptSegment,
  StateSchema,
  MemoryConfig,
  SceneNodeConfig,
  InputNodeConfig,
  CompressNodeConfig,
  StateUpdateNodeConfig,
} from './types';
import { StateStore } from './state-store';
import { MemoryManager, estimateTokens } from './memory';
import { assembleContext } from './context-assembler';
import { createTools, getEnabledTools } from './tool-executor';
import { LLMClient } from './llm-client';
import type { LLMConfig } from './llm-client';
import { FlowExecutor, createInitialProgress } from './flow-executor';
import type { NodeHandlers } from './flow-executor';
import { useGameStore } from '../stores/game-store';

// ============================================================================
// Types
// ============================================================================

export interface GameSessionConfig {
  chapterId: string;
  flowGraph: FlowGraph;
  segments: PromptSegment[];
  stateSchema: StateSchema;
  memoryConfig: MemoryConfig;
  llmConfig: LLMConfig;
  enabledTools?: string[];       // optional tool names to enable
  tokenBudget?: number;          // context window budget (default: 120000)
  inheritedSummary?: string;     // from previous chapter
}

// ============================================================================
// GameSession
// ============================================================================

export class GameSession {
  private stateStore!: StateStore;
  private memory!: MemoryManager;
  private llmClient!: LLMClient;
  private flowExecutor!: FlowExecutor;
  private segments!: PromptSegment[];
  private enabledTools!: string[];
  private tokenBudget!: number;

  // Player input promise resolution
  private inputResolve: ((text: string) => void) | null = null;

  // Compress function for memory
  private compressFn = async (entries: import('./types').MemoryEntry[]): Promise<string> => {
    // Simple concatenation fallback — in production, this would use LLM
    return entries
      .map((e) => `[${e.role}] ${e.content.slice(0, 200)}`)
      .join('\n');
  };

  /** Initialize and start the game session */
  async start(config: GameSessionConfig): Promise<void> {
    const store = useGameStore.getState();
    store.reset();
    store.setStatus('loading');

    try {
      // Initialize core modules
      this.stateStore = new StateStore(config.stateSchema);
      this.memory = new MemoryManager(config.memoryConfig);
      this.llmClient = new LLMClient(config.llmConfig);
      this.segments = config.segments;
      this.enabledTools = config.enabledTools ?? [];
      this.tokenBudget = config.tokenBudget ?? 120000;

      if (config.inheritedSummary) {
        this.memory.setInheritedSummary(config.inheritedSummary);
      }

      // Create flow executor
      const progress = createInitialProgress(config.flowGraph, config.chapterId);
      const handlers = this.createNodeHandlers();

      this.flowExecutor = new FlowExecutor(
        config.flowGraph,
        progress,
        handlers,
        {
          onNodeEnter: (node) => {
            store.updateDebug({
              currentNodeId: node.id,
              currentNodePhase: 'entering',
            });
          },
          onNodeExit: (node) => {
            store.updateDebug({
              currentNodeId: node.id,
              currentNodePhase: 'completed',
            });
          },
          onFlowComplete: () => {
            store.setStatus('idle');
            store.appendEntry({
              role: 'system',
              content: '章节结束。',
            });
          },
        },
      );

      // Sync initial state to UI
      this.syncDebugState();

      // Start flow execution
      await this.flowExecutor.run();
    } catch (error) {
      store.setError(error instanceof Error ? error.message : String(error));
    }
  }

  /** Submit player input (resolves the pending input promise) */
  submitInput(text: string): void {
    if (this.inputResolve) {
      this.inputResolve(text);
      this.inputResolve = null;
    }
  }

  /** Stop the session */
  stop(): void {
    this.flowExecutor?.stop();
    if (this.inputResolve) {
      this.inputResolve('');
      this.inputResolve = null;
    }
    useGameStore.getState().setStatus('idle');
  }

  // ============================================================================
  // NodeHandlers
  // ============================================================================

  private createNodeHandlers(): NodeHandlers {
    return {
      onScene: (node, config) => this.handleScene(node, config),
      onInput: (node, config) => this.handleInput(node, config),
      onCompress: (_node, config) => this.handleCompress(config),
      onStateUpdate: (_node, config) => this.handleStateUpdate(config),
      onCheckpoint: (_node) => this.handleCheckpoint(),
      getStateVars: () => this.stateStore.getAll(),
    };
  }

  private async handleScene(_node: FlowNode, config: SceneNodeConfig): Promise<{
    inputSignaled: boolean;
    inputHint?: string;
  }> {
    const store = useGameStore.getState();
    store.setStatus('generating');

    // Update turn
    const turn = this.stateStore.getTurn() + 1;
    this.stateStore.setTurn(turn);

    // Create tools
    const allTools = createTools({
      stateStore: this.stateStore,
      memory: this.memory,
      segments: this.segments,
      onSignalInput: (hint) => {
        store.setInputHint(hint ?? null);
      },
      onAdvanceFlow: (nodeId) => {
        this.flowExecutor.jumpTo(nodeId);
      },
      onSetMood: (_mood) => {
        // TODO: connect to UI mood system
      },
      onShowImage: (_assetId) => {
        // TODO: connect to UI image display
      },
    });
    const enabledToolSet = getEnabledTools(allTools, this.enabledTools);

    // Determine which segments to use for this scene
    const sceneSegments = config.promptSegments.length > 0
      ? this.segments.filter((s) => config.promptSegments.includes(s.id))
      : this.segments;

    // Assemble context
    const context = assembleContext({
      segments: sceneSegments,
      stateStore: this.stateStore,
      memory: this.memory,
      tokenBudget: this.tokenBudget,
      outputReserve: config.maxTokens ?? 4096,
    });

    // Update token breakdown in debug
    store.updateDebug({
      tokenBreakdown: context.tokenBreakdown,
    });

    // Call LLM
    const result = await this.llmClient.generate({
      systemPrompt: context.systemPrompt,
      messages: context.messages,
      tools: enabledToolSet,
      maxSteps: 10,
      maxOutputTokens: config.maxTokens,
      onTextChunk: (chunk) => {
        store.appendStreamingChunk(chunk);
      },
      onToolCall: (name, args) => {
        store.addToolCall({ name, args, result: undefined });
      },
      onToolResult: (name, toolResult) => {
        // Update the last matching tool call entry
        const calls = useGameStore.getState().toolCalls;
        const lastCall = [...calls].reverse().find(
          (c) => c.name === name && c.result === undefined,
        );
        if (lastCall) {
          lastCall.result = toolResult;
        }
      },
    });

    // Finalize streaming → append to narrative entries
    store.finalizeStreaming();

    // Store GM response in memory
    if (result.text) {
      this.memory.appendTurn({
        turn,
        role: 'gm',
        content: result.text,
        tokenCount: estimateTokens(result.text),
      });
    }

    // Check if memory needs compression
    if (this.memory.needsCompression()) {
      await this.memory.compress(this.compressFn);
    }

    // Sync debug state
    this.syncDebugState();

    // If auto scene and input was signaled, wait for input
    if (result.inputSignaled && !config.auto) {
      store.setStatus('waiting-input');
      const inputText = await this.waitForInput();

      if (inputText) {
        store.appendEntry({ role: 'pc', content: inputText });
        store.setStatus('generating');

        this.memory.appendTurn({
          turn,
          role: 'pc',
          content: inputText,
          tokenCount: estimateTokens(inputText),
        });
      }
    }

    return {
      inputSignaled: result.inputSignaled,
      inputHint: result.inputHint,
    };
  }

  private async handleInput(_node: FlowNode, config: InputNodeConfig): Promise<{
    text: string;
    savedToState?: string;
  }> {
    const store = useGameStore.getState();

    // Set up input mode
    if (config.inputType === 'choice' && config.choices) {
      const choiceList = Array.isArray(config.choices)
        ? config.choices
        : []; // fromState would need runtime resolution
      store.setInputType('choice', choiceList);
    } else {
      store.setInputType('freetext');
    }

    if (config.promptHint) {
      store.setInputHint(config.promptHint);
    }

    store.setStatus('waiting-input');

    // Wait for player input
    const text = await this.waitForInput();

    // Store in memory
    const turn = this.stateStore.getTurn();
    this.memory.appendTurn({
      turn,
      role: 'pc',
      content: text,
      tokenCount: estimateTokens(text),
    });

    // Append to narrative
    store.appendEntry({ role: 'pc', content: text });

    // Save to state if configured
    if (config.saveToState) {
      this.stateStore.set(config.saveToState, text, 'system');
    }

    // Reset input mode
    store.setInputType('freetext');
    store.setInputHint(null);

    this.syncDebugState();

    return {
      text,
      savedToState: config.saveToState,
    };
  }

  private async handleCompress(config: CompressNodeConfig): Promise<void> {
    if (config.pinItems) {
      for (const item of config.pinItems) {
        this.memory.pin(item);
      }
    }
    await this.memory.compress(this.compressFn);
    this.syncDebugState();
  }

  private async handleStateUpdate(config: StateUpdateNodeConfig): Promise<void> {
    this.stateStore.update(config.updates, 'system');
    this.syncDebugState();
  }

  private async handleCheckpoint(): Promise<void> {
    // TODO: Auto-save to IndexedDB
    const store = useGameStore.getState();
    store.appendEntry({
      role: 'system',
      content: '[Checkpoint saved]',
    });
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  private waitForInput(): Promise<string> {
    return new Promise<string>((resolve) => {
      this.inputResolve = resolve;
    });
  }

  private syncDebugState(): void {
    const store = useGameStore.getState();
    const progress = this.flowExecutor.getProgress();

    store.updateDebug({
      stateVars: this.stateStore.getAll(),
      currentNodeId: progress.currentNodeId,
      currentNodePhase: progress.nodePhase,
      totalTurns: progress.totalTurns,
      memoryEntryCount: this.memory.getAllEntries().length,
      memorySummaryCount: this.memory.getSummaries().length,
    });
  }
}
