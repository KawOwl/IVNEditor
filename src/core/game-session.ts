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
 *      - signal_input_needed 使用挂起模式：execute 挂起等玩家输入，LLM 拿到结果后继续
 *      - 一次 generate() 内可能有 0 次、1 次或多次玩家互动
 *   2. Receive: LLM 自然停止后，等待玩家输入（fallback，不经过 signal_input_needed）
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
import type { SignalInputOptions } from './tool-executor';
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

/**
 * SessionPersistence — 可选的持久化回调接口
 *
 * 远程模式下由 server 注入实现（写 DB），本地模式不传。
 * GameSession 在 coreLoop 的关键状态转换点调用这些回调。
 */
export interface SessionPersistence {
  /** generate 阶段开始 */
  onGenerateStart(turn: number): Promise<void>;

  /**
   * 一段 streaming entry 结束时（finalize 前）调用。
   * 触发时机：
   *   1. signal_input_needed 挂起前（保证挂起时叙事已入库）
   *   2. generate() 自然返回后（完整一轮叙事结束）
   *
   * 每次调用保存一条独立的 narrative_entry 到 DB。
   */
  onNarrativeSegmentFinalized(data: {
    entry: { role: string; content: string; reasoning?: string; toolCalls?: unknown[]; finishReason?: string };
  }): Promise<void>;

  /** generate() 全部结束后同步 memory 快照 + preview（不再负责 entry 入库） */
  onGenerateComplete(data: {
    memoryEntries: unknown[];
    memorySummaries: string[];
    preview?: string | null;
  }): Promise<void>;

  /** 进入等待输入状态（signal_input_needed 或外循环 receive phase） */
  onWaitingInput(data: {
    hint: string | null;
    inputType: string;
    choices: string[] | null;
  }): Promise<void>;

  /** 玩家输入完成 */
  onReceiveComplete(data: {
    entry: { role: string; content: string };
    stateVars: Record<string, unknown>;
    turn: number;
    memoryEntries: unknown[];
    memorySummaries: string[];
  }): Promise<void>;
}

/**
 * RestoreConfig — 从持久化快照恢复会话所需的数据
 */
export interface RestoreConfig {
  segments: PromptSegment[];
  stateSchema: StateSchema;
  memoryConfig: MemoryConfig;
  llmConfig: LLMConfig;
  enabledTools?: string[];
  tokenBudget?: number;
  initialPrompt?: string;
  assemblyOrder?: string[];
  disabledSections?: string[];
  persistence?: SessionPersistence;
  // 恢复数据
  stateVars: Record<string, unknown>;
  turn: number;
  memoryEntries: unknown[];       // MemoryEntry[] from DB (JSONB)
  memorySummaries: string[];
  status: string;                 // 恢复时的状态
  inputHint?: string | null;
  inputType?: string;
  choices?: string[] | null;
}

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
  disabledSections?: string[];   // 被禁用的 section ID 列表
  persistence?: SessionPersistence;  // 可选持久化（远程模式写 DB）
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
  private disabledSections?: string[];
  private persistence?: SessionPersistence;

  /**
   * 当前 streaming entry 的叙事文本累积区。
   * 用途：signal_input_needed 挂起时先把这段文本持久化到 DB，
   * 避免 generate() 一直挂起导致的叙事丢失。
   * 每次 beginStreamingEntry 前重置，每次 finalize 前 flush 到 DB。
   */
  private currentNarrativeBuffer = '';

  // Session lifecycle
  private active = false;

  // 外循环 Receive 阶段的挂起 Promise（LLM 自然停止后等玩家输入）
  private inputResolve: ((text: string) => void) | null = null;

  // 内循环挂起 Promise（signal_input_needed 等玩家输入）
  private signalInputResolve: ((text: string) => void) | null = null;

  // 用于中断进行中的 generate()（停止/重置时防挂死）
  private abortController: AbortController | null = null;

  // ReasoningFilter flush 回调：signal_input_needed 触发时需要先 flush 缓冲区
  private flushTextFilter: (() => void) | null = null;

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

  /** 即时更新 LLM 配置（下一次 generate 生效，无需重启会话） */
  updateLLMConfig(patch: Partial<import('./llm-client').LLMConfig>): void {
    this.llmClient?.updateConfig(patch);
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
      this.disabledSections = config.disabledSections;
      this.persistence = config.persistence;

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

  /**
   * 从持久化快照恢复会话（跳过 start() 的初始化，直接进入对应阶段）
   *
   * 恢复策略：
   *   - waiting-input → 直接进入 Receive Phase（等玩家输入）
   *   - generating → 视为上一轮未完成，进入 Receive Phase
   *   - idle → 等玩家触发，进入完整 coreLoop
   */
  async restore(config: RestoreConfig): Promise<void> {
    this.emitter.setStatus('loading');

    try {
      // 初始化核心模块（同 start）
      this.stateStore = new StateStore(config.stateSchema);
      this.memory = new MemoryManager(config.memoryConfig);
      this.llmClient = new LLMClient(config.llmConfig);
      this.segments = config.segments;
      this.enabledTools = config.enabledTools ?? [];
      this.tokenBudget = config.tokenBudget ?? 120000;
      this.initialPrompt = config.initialPrompt;
      this.assemblyOrder = config.assemblyOrder;
      this.disabledSections = config.disabledSections;
      this.persistence = config.persistence;

      // 注入持久化快照
      this.stateStore.restore(config.stateVars, config.turn);
      this.memory.restore(
        config.memoryEntries as import('./types').MemoryEntry[],
        config.memorySummaries,
      );

      // 同步 UI
      this.syncDebugState();

      this.active = true;

      // 根据恢复时的状态决定进入点
      if (config.status === 'waiting-input') {
        // 恢复 UI 状态（choices/hint）
        if (config.inputHint) this.emitter.setInputHint(config.inputHint);
        if (config.inputType === 'choice' && config.choices?.length) {
          this.emitter.setInputType('choice', config.choices);
        }
        this.emitter.setStatus('waiting-input');

        // 等玩家输入，然后进入 coreLoop
        const inputText = await this.waitForInput();
        if (!this.active) return;

        if (inputText) {
          this.emitter.appendEntry({ role: 'receive', content: inputText });
          this.memory.appendTurn({
            turn: config.turn,
            role: 'receive',
            content: inputText,
            tokenCount: estimateTokens(inputText),
          });
          await this.persistence?.onReceiveComplete({
            entry: { role: 'receive', content: inputText },
            stateVars: this.stateStore.getAll(),
            turn: config.turn,
            memoryEntries: this.memory.getAllEntries(),
            memorySummaries: this.memory.getSummaries(),
          }).catch((e) => console.error('[Persistence] onReceiveComplete (restore) failed:', e));
        }

        this.emitter.setInputHint(null);
        this.emitter.setInputType('freetext');

        // 继续正常 coreLoop
        await this.coreLoop();
      } else {
        // idle 或 generating → 从头开始 coreLoop
        await this.coreLoop();
      }
    } catch (error) {
      if (this.active) {
        this.emitter.setError(error instanceof Error ? error.message : String(error));
      }
    }
  }

  /** Submit player input — 分两路：挂起中（signal_input_needed）或外循环（Receive 阶段） */
  submitInput(text: string): void {
    if (this.signalInputResolve) {
      // 挂起模式：signal_input_needed 正在等玩家输入
      const resolve = this.signalInputResolve;
      this.signalInputResolve = null;

      // 清 UI 状态，恢复生成中
      this.emitter.setInputHint(null);
      this.emitter.setInputType('freetext');
      this.emitter.setStatus('generating');

      // 显示玩家输入到叙事流
      this.emitter.appendEntry({ role: 'receive', content: text });

      // 记录到记忆
      const turn = this.stateStore.getTurn();
      this.memory.appendTurn({
        turn,
        role: 'receive',
        content: text,
        tokenCount: estimateTokens(text),
      });

      // resolve → agentic loop 继续
      resolve(text);
    } else if (this.inputResolve) {
      // 外循环 Receive 阶段
      this.inputResolve(text);
      this.inputResolve = null;
    }
  }

  /** Stop the session */
  stop(): void {
    this.active = false;

    // 中断进行中的 generate()
    this.abortController?.abort();
    this.abortController = null;

    // resolve 所有 pending Promise（防挂死）
    if (this.signalInputResolve) {
      this.signalInputResolve('');
      this.signalInputResolve = null;
    }
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

      // ① 持久化：generate 开始
      await this.persistence?.onGenerateStart(turn).catch((e) =>
        console.error('[Persistence] onGenerateStart failed:', e));

      try {
        // Create tools with suspend-mode waitForPlayerInput
        const allTools = createTools({
          stateStore: this.stateStore,
          memory: this.memory,
          segments: this.segments,
          waitForPlayerInput: this.createWaitForPlayerInput(),
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
          disabledSections: this.disabledSections,
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

        // Create abort controller for this generate() call
        this.abortController = new AbortController();

        // 创建 streaming entry（文本将直接追加到这条 entry）
        this.currentNarrativeBuffer = '';
        this.emitter.beginStreamingEntry();

        // Call LLM (agentic tool loop — signal_input_needed 会挂起等玩家)
        //
        // 推理过滤策略：
        // 1. 有原生思考（thinkingEnabled）→ 跳过，text-delta 是纯叙事
        // 2. 无原生思考 + reasoningFilterEnabled → 启发式分离推理/叙事
        // 3. 无原生思考 + !reasoningFilterEnabled → 跳过，全部当叙事
        const hasNativeReasoning = this.llmClient.isThinkingEnabled();
        const useFilter = !hasNativeReasoning && this.llmClient.isReasoningFilterEnabled();

        const textFilter = useFilter ? new ReasoningFilter(
          (reasoning) => this.emitter.appendReasoningToStreamingEntry(reasoning),
          (text) => {
            this.currentNarrativeBuffer += text;
            this.emitter.appendToStreamingEntry(text);
          },
        ) : null;
        // 存 flush 引用，供 createWaitForPlayerInput() 在挂起前刷出缓冲文本
        this.flushTextFilter = textFilter ? () => textFilter.flush() : null;
        const result = await this.llmClient.generate({
          systemPrompt: context.systemPrompt,
          messages: context.messages,
          tools: enabledToolSet,
          maxSteps: 30,
          abortSignal: this.abortController.signal,
          onTextChunk: (chunk) => {
            if (textFilter) {
              textFilter.push(chunk);
            } else {
              // 原生思考模式：text-delta 直接作为叙事正文
              this.currentNarrativeBuffer += chunk;
              this.emitter.appendToStreamingEntry(chunk);
            }
          },
          onReasoningChunk: (chunk) => {
            this.emitter.appendReasoningToStreamingEntry(chunk);
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

        this.abortController = null;

        // Flush any buffered text in the reasoning filter
        textFilter?.flush();

        // Stage finish reason
        this.emitter.stagePendingDebug({ finishReason: result.finishReason });

        // Finalize streaming → append to narrative entries (with attached debug info)
        this.emitter.finalizeStreamingEntry();

        // Store LLM response in memory
        if (result.text) {
          this.memory.appendTurn({
            turn,
            role: 'generate',
            content: result.text,
            tokenCount: estimateTokens(result.text),
          });
        }

        // ② 持久化：最后一段 streaming entry（generate 自然返回后）
        //    注：如果中间有 signal_input_needed 挂起，那些段已在 createWaitForPlayerInput 中持久化过了
        if (this.currentNarrativeBuffer) {
          await this.persistence?.onNarrativeSegmentFinalized({
            entry: {
              role: 'generate',
              content: this.currentNarrativeBuffer,
              finishReason: result.finishReason,
            },
          }).catch((e) => console.error('[Persistence] onNarrativeSegmentFinalized (final) failed:', e));
          this.currentNarrativeBuffer = '';
        }

        // 同步 memory 快照和 preview
        await this.persistence?.onGenerateComplete({
          memoryEntries: this.memory.getAllEntries(),
          memorySummaries: this.memory.getSummaries(),
          preview: result.text ? result.text.slice(0, 80).replace(/\n/g, ' ') : null,
        }).catch((e) => console.error('[Persistence] onGenerateComplete failed:', e));

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
        this.emitter.finalizeStreamingEntry();
        // Show error banner but don't change status — Receive Phase will set waiting-input
        this.emitter.setError(error instanceof Error ? error.message : String(error));
        // Fall through to Receive Phase — player can re-send to retry
      }

      // --- Receive Phase (fallback) ---
      // LLM 自然停止后（没有通过 signal_input_needed 请求输入），等玩家输入再开始下一轮。
      // 如果 LLM 在 generate 过程中已经通过 signal_input_needed 获取了玩家输入，
      // 这里仍然需要等——因为 LLM 停下意味着这一轮叙事结束了，需要玩家推动下一轮。
      if (this.active) {
        this.emitter.setStatus('waiting-input');

        // ③ 持久化：进入等待输入（外循环 receive phase）
        await this.persistence?.onWaitingInput({
          hint: null,
          inputType: 'freetext',
          choices: null,
        }).catch((e) => console.error('[Persistence] onWaitingInput failed:', e));

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

          // ④ 持久化：receive 完成
          await this.persistence?.onReceiveComplete({
            entry: { role: 'receive', content: inputText },
            stateVars: this.stateStore.getAll(),
            turn,
            memoryEntries: this.memory.getAllEntries(),
            memorySummaries: this.memory.getSummaries(),
          }).catch((e) => console.error('[Persistence] onReceiveComplete failed:', e));
        }

        this.emitter.setInputHint(null);
        this.emitter.setInputType('freetext');
      }
    }
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /** 创建 waitForPlayerInput 回调，供 signal_input_needed 的 execute 使用 */
  private createWaitForPlayerInput(): (options: SignalInputOptions) => Promise<string> {
    return async (options: SignalInputOptions) => {
      // 先 flush ReasoningFilter 缓冲区，确保所有文本都写进 streaming entry
      this.flushTextFilter?.();

      // ★ 关键修复：挂起前先把当前累积的叙事段持久化到 DB
      //   否则 generate() 会挂起在这里一直不返回，
      //   onGenerateComplete 永远不会被调用，这段叙事就永远写不进 DB
      if (this.currentNarrativeBuffer) {
        await this.persistence?.onNarrativeSegmentFinalized({
          entry: {
            role: 'generate',
            content: this.currentNarrativeBuffer,
          },
        }).catch((e) =>
          console.error('[Persistence] onNarrativeSegmentFinalized (signal) failed:', e),
        );
        this.currentNarrativeBuffer = '';
      }

      // 将当前 streaming entry 标记为完成
      this.emitter.finalizeStreamingEntry();

      // 更新 UI：显示选项和提示
      this.emitter.setInputHint(options.hint ?? null);
      if (options.choices && options.choices.length > 0) {
        this.emitter.setInputType('choice', options.choices);
      }
      this.emitter.setStatus('waiting-input');

      // ③ 持久化：signal_input_needed 触发的等待输入
      await this.persistence?.onWaitingInput({
        hint: options.hint ?? null,
        inputType: options.choices?.length ? 'choice' : 'freetext',
        choices: options.choices ?? null,
      }).catch((e) => console.error('[Persistence] onWaitingInput (signal) failed:', e));

      // 返回挂起 Promise，等 submitInput() 调用时 resolve
      return new Promise<string>((resolve) => {
        this.signalInputResolve = (text: string) => {
          // 玩家输入后，开始新的 streaming entry 接收 LLM 后续输出
          this.currentNarrativeBuffer = '';
          this.emitter.beginStreamingEntry();
          resolve(text);
        };
      });
    };
  }

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
