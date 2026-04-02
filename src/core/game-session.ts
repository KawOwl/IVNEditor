/**
 * GameSession — 端到端集成层
 *
 * 串联所有核心模块：
 *   StateStore, MemoryManager, ContextAssembler, ToolExecutor, LLMClient
 *
 * 通过 SessionEmitter 接口向视图层推送事件，不直接依赖 Zustand。
 * 这使得 GameSession 可以在前端或后端运行。
 *
 * 核心循环：Generate + Receive
 *   1. Generate: 组装 context → 调用 LLM（agentic tool loop）→ 追加记忆 → 按需压缩
 *   2. Receive: 等待外部输入 → 追加记忆
 *   循环直到 session 被停止
 *
 * 对外只暴露简单的 API：
 *   - start(config): 初始化并开始运行
 *   - submitInput(text): 提交玩家输入
 *   - stop(): 停止
 */

import type {
  PromptSegment,
  StateSchema,
  MemoryConfig,
} from './types';
import { StateStore } from './state-store';
import { MemoryManager, estimateTokens } from './memory';
import { assembleContext } from './context-assembler';
import { createTools, getEnabledTools } from './tool-executor';
import { LLMClient } from './llm-client';
import type { LLMConfig } from './llm-client';
import type { SessionEmitter } from './session-emitter';

// ============================================================================
// ReasoningFilter — 启发式分离 LLM 推理文本与叙事正文
// ============================================================================

/**
 * 某些模型（如 deepseek-chat）将推理过程直接输出到 content 中，
 * 而非通过 reasoning_content 字段。此过滤器在流式输出中检测并分离推理文本。
 *
 * 策略：缓冲初始文本，检测到叙事起始标记后，将缓冲内容分类为 reasoning，
 * 后续内容直接作为叙事正文传递。
 */
class ReasoningFilter {
  private buffer = '';
  private resolved = false; // true = 已确定推理/正文边界
  private onReasoning: (text: string) => void;
  private onText: (text: string) => void;

  /** 叙事正文的起始标记（出现任一即认为正文开始） */
  private static NARRATIVE_MARKERS = /\n---[\s\n]|\n#{1,3}\s|\n\*\*/;

  constructor(
    onReasoning: (text: string) => void,
    onText: (text: string) => void,
  ) {
    this.onReasoning = onReasoning;
    this.onText = onText;
  }

  push(chunk: string): void {
    if (this.resolved) {
      // 边界已确定，直接传递正文
      this.onText(chunk);
      return;
    }

    this.buffer += chunk;

    // 检测叙事标记
    const match = ReasoningFilter.NARRATIVE_MARKERS.exec(this.buffer);
    if (match) {
      // 标记前的内容是推理，标记及之后是正文
      const reasoningPart = this.buffer.slice(0, match.index).trim();
      const narrativePart = this.buffer.slice(match.index);

      if (reasoningPart) {
        this.onReasoning(reasoningPart);
      }
      this.onText(narrativePart);
      this.resolved = true;
      return;
    }

    // 缓冲超过 500 字符仍无标记 → 认为全是正文（无推理前缀）
    if (this.buffer.length > 500) {
      this.onText(this.buffer);
      this.resolved = true;
    }
  }

  /** 流结束时 flush 剩余缓冲 */
  flush(): void {
    if (!this.resolved && this.buffer) {
      // 从未检测到标记，全部视为正文
      this.onText(this.buffer);
      this.resolved = true;
    }
  }
}

// ============================================================================
// Types
// ============================================================================

export interface GameSessionConfig {
  chapterId: string;
  segments: PromptSegment[];
  stateSchema: StateSchema;
  memoryConfig: MemoryConfig;
  llmConfig: LLMConfig;
  enabledTools?: string[];       // optional tool names to enable
  tokenBudget?: number;          // context window budget (default: 120000)
  inheritedSummary?: string;     // from previous chapter
  initialPrompt?: string;        // 首轮 user message（等效于 prompt.txt）
  assemblyOrder?: string[];      // 自定义 prompt 组装顺序
}

// ============================================================================
// GameSession
// ============================================================================

export class GameSession {
  private emitter: SessionEmitter;

  private stateStore!: StateStore;
  private memory!: MemoryManager;
  private llmClient!: LLMClient;
  private segments!: PromptSegment[];
  private enabledTools!: string[];
  private tokenBudget!: number;
  private initialPrompt?: string;
  private assemblyOrder?: string[];
  // Session lifecycle
  private active = false;

  // Player input promise resolution
  private inputResolve: ((text: string) => void) | null = null;

  // Compress function for memory
  private compressFn = async (entries: import('./types').MemoryEntry[]): Promise<string> => {
    // Simple concatenation fallback — in production, this would use LLM
    return entries
      .map((e) => `[${e.role}] ${e.content.slice(0, 200)}`)
      .join('\n');
  };

  constructor(emitter: SessionEmitter) {
    this.emitter = emitter;
  }

  /** Initialize and start the game session */
  async start(config: GameSessionConfig): Promise<void> {
    this.emitter.reset();
    this.emitter.setStatus('loading');

    try {
      // Initialize core modules
      this.stateStore = new StateStore(config.stateSchema);
      this.memory = new MemoryManager(config.memoryConfig);
      this.llmClient = new LLMClient(config.llmConfig);
      this.segments = config.segments;
      this.enabledTools = config.enabledTools ?? [];
      this.tokenBudget = config.tokenBudget ?? 120000;
      this.initialPrompt = config.initialPrompt;
      this.assemblyOrder = config.assemblyOrder;

      if (config.inheritedSummary) {
        this.memory.setInheritedSummary(config.inheritedSummary);
      }

      // Sync initial state to UI
      this.syncDebugState();

      // Start core loop
      this.active = true;
      await this.coreLoop();
    } catch (error) {
      if (this.active) {
        this.emitter.setError(error instanceof Error ? error.message : String(error));
      }
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
    this.active = false;
    if (this.inputResolve) {
      this.inputResolve('');
      this.inputResolve = null;
    }
    this.emitter.setStatus('idle');
  }

  // ============================================================================
  // Core Loop — Generate + Receive
  // ============================================================================

  private async coreLoop(): Promise<void> {
    while (this.active) {
      // --- Generate Phase ---
      this.emitter.setStatus('generating');
      const turn = this.stateStore.getTurn() + 1;
      this.stateStore.setTurn(turn);

      try {
        // Create tools with callbacks
        const allTools = createTools({
          stateStore: this.stateStore,
          memory: this.memory,
          segments: this.segments,
          // signal_input_needed 是终止工具（no-execute），
          // choices/hint 从 generate() 返回值中提取，见下方
          onSignalInput: () => {},
          onSetMood: (_mood) => {
            // TODO: connect to UI mood system
          },
          onShowImage: (_assetId) => {
            // TODO: connect to UI image display
          },
        });
        const enabledToolSet = getEnabledTools(allTools, this.enabledTools);

        // Assemble context
        const context = assembleContext({
          segments: this.segments,
          stateStore: this.stateStore,
          memory: this.memory,
          tokenBudget: this.tokenBudget,
          initialPrompt: this.initialPrompt,
          assemblyOrder: this.assemblyOrder,
        });

        // Compute active segment IDs
        const activeSegmentIds = this.segments
          .filter((s) => {
            if (!s.injectionRule) return true;
            try {
              const vars = this.stateStore.getAll();
              const keys = Object.keys(vars);
              const values = keys.map((k) => vars[k]);
              const fn = new Function(...keys, `try { return !!(${s.injectionRule.condition}); } catch { return false; }`);
              return fn(...values);
            } catch { return false; }
          })
          .map((s) => s.id);

        // Update global debug state
        this.emitter.updateDebug({
          tokenBreakdown: context.tokenBreakdown,
          assembledSystemPrompt: context.systemPrompt,
          assembledMessages: context.messages.map((m) => ({ role: m.role, content: m.content })),
          activeSegmentIds,
        });

        // Stage prompt snapshot for this generation entry
        this.emitter.stagePendingDebug({
          promptSnapshot: {
            systemPrompt: context.systemPrompt,
            messages: context.messages.map((m) => ({ role: m.role, content: m.content })),
            tokenBreakdown: context.tokenBreakdown,
            activeSegmentIds,
          },
        });

        // Call LLM (agentic tool loop)
        const textFilter = new ReasoningFilter(
          (reasoning) => this.emitter.appendReasoningChunk(reasoning),
          (text) => this.emitter.appendTextChunk(text),
        );
        const result = await this.llmClient.generate({
          systemPrompt: context.systemPrompt,
          messages: context.messages,
          tools: enabledToolSet,
          maxSteps: 10,
          onTextChunk: (chunk) => {
            textFilter.push(chunk);
          },
          onReasoningChunk: (chunk) => {
            this.emitter.appendReasoningChunk(chunk);
          },
          onToolCall: (name, args) => {
            this.emitter.addToolCall({ name, args, result: undefined });
            this.emitter.addPendingToolCall({ name, args, result: undefined });
          },
          onToolResult: (name, toolResult) => {
            this.emitter.updateToolResult(name, toolResult);
            this.emitter.updatePendingToolResult(name, toolResult);
          },
        });

        // Flush any buffered text in the reasoning filter
        textFilter.flush();

        // 从 generate 返回值中提取 signal_input_needed 的参数（终止工具没有 execute）
        if (result.inputSignaled) {
          this.emitter.setInputHint(result.inputHint ?? null);
          if (result.inputChoices && result.inputChoices.length > 0) {
            this.emitter.setInputType('choice', result.inputChoices);
          }
        }

        // Stage finish reason
        this.emitter.stagePendingDebug({ finishReason: result.finishReason });

        // Finalize streaming → append to narrative entries (with attached debug info)
        this.emitter.finalizeStreaming();

        // Store LLM response in memory
        if (result.text) {
          this.memory.appendTurn({
            turn,
            role: 'generate',
            content: result.text,
            tokenCount: estimateTokens(result.text),
          });
        }

        // Check if memory needs compression
        if (this.memory.needsCompression()) {
          this.emitter.setStatus('compressing');
          await this.memory.compress(this.compressFn);
        }

        // Sync debug state
        this.syncDebugState();

      } catch (error) {
        if (!this.active) break;
        // Finalize any partial streaming content so it's not lost
        this.emitter.finalizeStreaming();
        // Show error banner but don't change status — Receive Phase will set waiting-input
        this.emitter.setError(error instanceof Error ? error.message : String(error));
        // Fall through to Receive Phase — player can re-send to retry
      }

      // --- Receive Phase ---
      // 默认行为：回复结束 = 等待玩家输入（与 chat 一致）。
      // signal_input_needed 仅用于提供 prompt hint，不再是必需的。
      if (this.active) {
        this.emitter.setStatus('waiting-input');
        const inputText = await this.waitForInput();

        if (!this.active) break; // stopped while waiting

        // Clear error banner on new input
        this.emitter.setError(null);

        if (inputText) {
          this.emitter.appendEntry({ role: 'receive', content: inputText });

          this.memory.appendTurn({
            turn,
            role: 'receive',
            content: inputText,
            tokenCount: estimateTokens(inputText),
          });
        }

        this.emitter.setInputHint(null);
        this.emitter.setInputType('freetext');
      }
    }
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
    this.emitter.updateDebug({
      stateVars: this.stateStore.getAll(),
      totalTurns: this.stateStore.getTurn(),
      memoryEntryCount: this.memory.getAllEntries().length,
      memorySummaryCount: this.memory.getSummaries().length,
    });
  }
}
