/**
 * FlowExecutor — FlowGraph 状态机执行器
 *
 * 管理 FlowGraph 中节点的遍历和执行。
 * 每种节点类型有对应的处理逻辑：
 *   - scene: 调用 LLM 生成叙事
 *   - input: 等待玩家输入
 *   - compress: 触发记忆压缩
 *   - state-update: 批量更新状态
 *   - checkpoint: 标记存档点
 *
 * FlowExecutor 不直接持有 LLM/Memory/State 实例，
 * 而是通过 NodeHandler 回调将控制权交给上层 GameSession。
 */

import type {
  FlowGraph,
  FlowNode,
  FlowEdge,
  ProgressState,
  SceneNodeConfig,
  InputNodeConfig,
  CompressNodeConfig,
  StateUpdateNodeConfig,
} from './types';
import { evaluateCondition } from './context-assembler';

// ============================================================================
// Types
// ============================================================================

export interface NodeHandlers {
  /** Handle scene node: call LLM, stream narrative */
  onScene: (node: FlowNode, config: SceneNodeConfig) => Promise<SceneResult>;
  /** Handle input node: wait for player input */
  onInput: (node: FlowNode, config: InputNodeConfig) => Promise<InputResult>;
  /** Handle compress node: trigger memory compression */
  onCompress: (node: FlowNode, config: CompressNodeConfig) => Promise<void>;
  /** Handle state-update node: batch update state */
  onStateUpdate: (node: FlowNode, config: StateUpdateNodeConfig) => Promise<void>;
  /** Handle checkpoint node: create save point */
  onCheckpoint: (node: FlowNode) => Promise<void>;
  /** Get current state variables for condition evaluation */
  getStateVars: () => Record<string, unknown>;
}

export interface SceneResult {
  /** Whether signal_input_needed was called during generation */
  inputSignaled: boolean;
  /** Optional prompt hint from signal_input_needed */
  inputHint?: string;
}

export interface InputResult {
  /** The player's input text */
  text: string;
  /** State key to save the input to (from InputNodeConfig.saveToState) */
  savedToState?: string;
}

export interface FlowExecutorEvents {
  onNodeEnter?: (node: FlowNode) => void;
  onNodeExit?: (node: FlowNode) => void;
  onEdgeTraverse?: (edge: FlowEdge) => void;
  onFlowComplete?: () => void;
}

// ============================================================================
// FlowExecutor
// ============================================================================

export class FlowExecutor {
  readonly graph: FlowGraph;
  private nodeMap: Map<string, FlowNode>;
  private edgesBySource: Map<string, FlowEdge[]>;
  private progress: ProgressState;
  private handlers: NodeHandlers;
  private events: FlowExecutorEvents;
  private running = false;
  private paused = false;

  constructor(
    graph: FlowGraph,
    progress: ProgressState,
    handlers: NodeHandlers,
    events: FlowExecutorEvents = {},
  ) {
    this.graph = graph;
    this.progress = progress;
    this.handlers = handlers;
    this.events = events;

    // Build lookup maps
    this.nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
    this.edgesBySource = new Map();
    for (const edge of graph.edges) {
      const existing = this.edgesBySource.get(edge.from) ?? [];
      existing.push(edge);
      this.edgesBySource.set(edge.from, existing);
    }
  }

  // --- Public API ---

  /** Start or resume flow execution from current node */
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.paused = false;

    try {
      while (this.running && !this.paused) {
        const node = this.nodeMap.get(this.progress.currentNodeId);
        if (!node) {
          throw new Error(`Node "${this.progress.currentNodeId}" not found in flow graph`);
        }

        // Execute current node
        this.events.onNodeEnter?.(node);
        this.progress.nodePhase = 'generating';

        await this.executeNode(node);

        this.progress.nodePhase = 'completed';
        this.events.onNodeExit?.(node);

        // Record visit
        if (!this.progress.visitedNodes.includes(node.id)) {
          this.progress.visitedNodes.push(node.id);
        }

        // Advance to next node
        const nextNodeId = this.resolveNextNode(node.id);
        if (!nextNodeId) {
          // No outgoing edges — flow is complete
          this.events.onFlowComplete?.();
          break;
        }

        this.progress.currentNodeId = nextNodeId;
      }
    } finally {
      this.running = false;
    }
  }

  /** Pause execution after current node completes */
  pause(): void {
    this.paused = true;
  }

  /** Stop execution immediately */
  stop(): void {
    this.running = false;
    this.paused = false;
  }

  /** Jump to a specific node (called by advance_flow tool) */
  jumpTo(nodeId: string): void {
    if (!this.nodeMap.has(nodeId)) {
      throw new Error(`Cannot jump to unknown node "${nodeId}"`);
    }
    this.progress.currentNodeId = nodeId;
    this.progress.nodePhase = 'pending';
  }

  /** Get current progress state */
  getProgress(): ProgressState {
    return { ...this.progress };
  }

  /** Update progress state (for load/restore) */
  setProgress(progress: ProgressState): void {
    this.progress = { ...progress };
  }

  /** Get a node by ID */
  getNode(nodeId: string): FlowNode | undefined {
    return this.nodeMap.get(nodeId);
  }

  /** Get all outgoing edges from a node */
  getOutgoingEdges(nodeId: string): FlowEdge[] {
    return this.edgesBySource.get(nodeId) ?? [];
  }

  // --- Node Execution ---

  private async executeNode(node: FlowNode): Promise<void> {
    const config = node.config;

    switch (config.type) {
      case 'scene': {
        this.progress.nodePhase = 'generating';
        const result = await this.handlers.onScene(node, config);
        this.progress.totalTurns++;

        // If the scene signals input needed, the handler should have
        // already collected the input. We just track the turn count.
        if (result.inputSignaled) {
          this.progress.nodePhase = 'waiting-input';
        }
        break;
      }

      case 'input': {
        this.progress.nodePhase = 'waiting-input';
        const result = await this.handlers.onInput(node, config);
        this.progress.totalTurns++;

        // Track loop counter for nodes that may be revisited
        const count = this.progress.loopCounters[node.id] ?? 0;
        this.progress.loopCounters[node.id] = count + 1;

        // If the input was a choice that determines the next edge,
        // it will be handled in resolveNextNode via state
        if (result.savedToState) {
          // State update is handled by the handler
        }
        break;
      }

      case 'compress': {
        await this.handlers.onCompress(node, config);
        break;
      }

      case 'state-update': {
        await this.handlers.onStateUpdate(node, config);
        break;
      }

      case 'checkpoint': {
        await this.handlers.onCheckpoint(node);
        break;
      }

      default: {
        // Exhaustive check
        const _exhaustive: never = config;
        throw new Error(`Unknown node type: ${(_exhaustive as { type: string }).type}`);
      }
    }
  }

  // --- Edge Resolution ---

  /**
   * Resolve which node to go to next from the given source node.
   * Evaluates edge conditions against current state.
   * Returns null if no valid outgoing edge exists (flow end).
   */
  private resolveNextNode(sourceId: string): string | null {
    const edges = this.edgesBySource.get(sourceId);
    if (!edges || edges.length === 0) return null;

    const vars = this.handlers.getStateVars();

    // Evaluate conditional edges first, then fall back to default (no condition)
    let defaultEdge: FlowEdge | null = null;

    for (const edge of edges) {
      if (!edge.condition) {
        // Default edge (no condition) — use as fallback
        defaultEdge = edge;
        continue;
      }

      if (evaluateCondition(edge.condition, vars)) {
        this.events.onEdgeTraverse?.(edge);
        return edge.to;
      }
    }

    // No conditional edge matched; use default
    if (defaultEdge) {
      this.events.onEdgeTraverse?.(defaultEdge);
      return defaultEdge.to;
    }

    return null;
  }
}

// ============================================================================
// Helper: Create initial ProgressState for a flow graph
// ============================================================================

export function createInitialProgress(
  graph: FlowGraph,
  chapterId: string,
  startNodeId?: string,
): ProgressState {
  const firstNodeId = startNodeId ?? graph.nodes[0]?.id;
  if (!firstNodeId) {
    throw new Error('Flow graph has no nodes');
  }

  return {
    currentChapterId: chapterId,
    currentNodeId: firstNodeId,
    nodePhase: 'pending',
    loopCounters: {},
    visitedNodes: [],
    totalTurns: 0,
  };
}
