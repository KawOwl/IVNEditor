/**
 * Memory 抽象接口
 *
 * 这个模块定义了 `_engine_memory` section 的来源 + 跨 generate 的历史持久化
 * 的统一契约。具体实现放在 `./legacy/`、`./llm-summarizer/`、`./mem0/` 下。
 *
 * 设计决策（详见 .claude/plans/memory-refactor.md）：
 *   - 所有方法 async（一次性改完，避免 sync/async 混杂）
 *   - 构造时绑定 scope，之后读写自动作用到 scope 上
 *   - recent messages 由 adapter 产出（role 翻译 + budget cap），不再由
 *     context-assembler 手写 for 循环
 *   - 章节不再是 memory 的生命周期事件（接口没有 finalize/setInheritedSummary）
 *   - retrieve 允许空 query，adapter 自行兜底
 */

import type { ModelMessage } from 'ai';
import type { MemoryEntry, MemoryConfig } from '../types';

/**
 * Memory scope —— 绑定到具体的 playthrough
 *
 * 构造时一次性提供，所有读写自动绑定，调用方不重复传。
 *
 * - mem0 adapter 把 playthroughId 映射为 user_id
 * - legacy adapter 忽略 scope（状态全在实例里）
 * - chapterId 是可选 tag，不作生命周期信号（章节不是 memory 事件）
 */
export interface MemoryScope {
  playthroughId: string;
  userId: string;
  chapterId?: string;
}

/**
 * 一次 retrieve 的结果
 *
 * - `summary`: `_engine_memory` section 的文本内容（空串表示 section 不出现）
 * - `entries`: 供 query_memory tool 展示给 LLM 的相关原始条目（可选）
 * - `meta`: adapter 特定的观测信息（mem0 relevance score 等），进 trace 用
 */
export interface MemoryRetrieval {
  summary: string;
  entries?: MemoryEntry[];
  meta?: Record<string, unknown>;
}

/**
 * getRecentAsMessages 的返回
 *
 * `messages` 是 AI SDK 原生 ModelMessage —— assistant 可能带 ToolCallPart[]，
 * 一条 tool-role 消息可能紧跟其后带 ToolResultPart[]（见 messages-builder）。
 * 2026-04-24 前是本地 ChatMessage（string content only），adapter 把 tool_call
 * / signal_input entries 过滤掉，导致 LLM 看不到自己的工具调用历史。
 */
export interface RecentMessagesResult {
  messages: ModelMessage[];
  tokensUsed: number;
}

/**
 * 快照 —— opaque JSON，由 adapter 自己解释
 *
 * - legacy: { kind:'legacy-v1', entries, summaries, watermark }
 * - mem0:   { kind:'mem0-v1', recentEntries, ... }（云端数据不在 snapshot 里）
 *
 * adapter.restore 必须先检 kind 再解包；不认的 kind 抛错。
 */
export type MemorySnapshot = Record<string, unknown>;

/**
 * Memory 抽象接口
 *
 * 非职责：
 *   - 不管 state 快照、tool 注册、LLM 调用
 *   - 不管章节边界（章节是 state 事件，不触发 Memory 方法）
 *   - 不参与 prepareStep，AI SDK step 间不会回调到 Memory
 */
export interface Memory {
  readonly kind: string;

  // ─── Write ─────────────────────────────────────────────────────────

  /**
   * 通知 adapter 有新内容发生（一次对话轮次的 narrative / player input）。
   *
   * **Memory Refactor v2 后实际语义变了**（2026-04-23）：
   *   - **Legacy / LLMSummarizer**：**几乎 no-op**。仅返回一个占位 MemoryEntry，
   *     不存任何 state。历史 entries 由 NarrativeHistoryReader 从 canonical
   *     narrative_entries 按需读；摘要由 maybeCompact 压缩产生。
   *   - **Mem0**：**真做事** —— 推送到云端做长期语义记忆。本地 recentEntries
   *     窗口也会更新（供 getRecentAsMessages 用）。
   *
   * caller（game-session）按 turn/role/content 传，不关心 adapter 内部怎么
   * 处理。**接口签名保持不变以减少迁移成本** —— 改名（如 observeEntry）收益
   * 不大且侵入所有 adapter + 调用点，暂不做。如果未来 mem0 需要 batchId /
   * orderIdx 等更丰富的元数据，再考虑加 observeEntry(NarrativeEntry) 方法。
   *
   * 历史：v1（挂起模式 + memory 自持 entries）里 appendTurn 是 memory 的核心
   * 写路径，adapter 内部生成 id / timestamp / pinned=false、把 entry push 进
   * state.entries。v2 后 state.entries 删除，appendTurn 降级为"通知 hook"。
   */
  appendTurn(params: {
    turn: number;
    role: MemoryEntry['role'];
    content: string;
    tokenCount: number;
    tags?: string[];
  }): Promise<MemoryEntry>;

  /** LLM 调 pin_memory tool 时触发 */
  pin(content: string, tags?: string[]): Promise<MemoryEntry>;

  // ─── Read ──────────────────────────────────────────────────────────

  /**
   * 检索与当前上下文相关的记忆；产出 `_engine_memory` section 的文本。
   *
   * 调用约定：
   *   - 一轮 generate 里**至少调一次**（context-assembler 在 step 0 前），
   *     **可能再多次调**（query_memory tool 在 step 内主动触发）
   *   - 必须幂等、无副作用：不能 flush、不能改内部状态
   *   - 不放进 prepareStep 的 per-step callback
   *
   * @param query 检索 hint，具体用法由 adapter 决定。
   *   **空字符串是合法输入**，adapter 必须返回合理默认值，不得抛错：
   *     - Legacy: 空 query → summary 正常返回，entries 返回 []
   *     - Mem0:   空 query → 按 adapter 内部策略兜底（Phase 3 定）
   *
   *   由 `game-session.buildRetrievalQuery()` 生成，是**刻意保留的扩展点**：
   *   Phase 1 简单返回最近玩家输入；未来可升级为 LLM 根据 state + 叙事
   *   动态生成 —— 升级时 Memory 接口不动。
   *
   * @param hints adapter 特定参数（topK、filter 等）
   */
  retrieve(query: string, hints?: Record<string, unknown>): Promise<MemoryRetrieval>;

  /**
   * 产出 messages[] 通道的 recent history，附带 budget cap。
   *
   * 职责从 context-assembler 挪进来：role 翻译 + budget break 封在 adapter 内，
   * assembler 一行调用即可拿到 ChatMessage[]。
   */
  getRecentAsMessages(opts: { budget: number }): Promise<RecentMessagesResult>;

  // ─── Lifecycle ─────────────────────────────────────────────────────

  /**
   * 让 adapter 决定是否触发内部压缩 / 远端同步 / 清理。
   *
   * 调用时机：每轮 generate 完成后（在 appendTurn + snapshot 之后）
   *
   *   - legacy: 查 total tokens > threshold → 真压缩
   *   - llm-summarizer: 同上，compressFn 走真 LLM
   *   - mem0: 批量 flush 最近 entries 到云端
   */
  maybeCompact(): Promise<void>;

  /** 序列化当前状态；外层写 DB */
  snapshot(): Promise<MemorySnapshot>;

  /** 从 snapshot 恢复；构造后或断线重连时调用 */
  restore(snapshot: MemorySnapshot): Promise<void>;

  /** 清空当前状态（剧本重开 / 外部触发"章节硬重置"时用） */
  reset(): Promise<void>;
}

/**
 * Factory options —— createMemory 的入参
 */
export interface CreateMemoryOptions {
  scope: MemoryScope;
  config: MemoryConfig;
  /** LLMSummarizer 需要；legacy / mem0 忽略 */
  llmClient?: import('../llm-client').LLMClient;
  /**
   * mem0 adapter 需要的 API key —— 由 server 侧从 env / secret 读取后注入，
   * factory 不直接读 process.env（因为 factory 也会被前端 tsc 编译，
   * 前端没有 process 全局）。
   *
   * 也可以通过 config.providerOptions.apiKey 覆盖（剧本级定制），优先级更高。
   */
  mem0ApiKey?: string;
  /**
   * Memory Refactor v2（2026-04-23）：从 canonical narrative_entries 读历史的
   * 接口。legacy / llm-summarizer 的 retrieve / getRecentAsMessages / maybeCompact
   * 通过它拉 entries，不再自己持有副本。
   *
   * mem0 adapter 暂不依赖 reader（本地 recentEntries 窗口已够用）。
   * 单元测试可以不传 —— adapter 内部 reader undefined 时保守返回空 messages。
   *
   * 详见 .claude/plans/memory-refactor-v2.md
   */
  reader?: import('./narrative-reader').NarrativeHistoryReader;
}
