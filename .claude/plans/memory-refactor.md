# 记忆模块抽象重构（v1 —— 已上线）

> **⚠️ 已被 `memory-refactor-v2.md` 取代（2026-04-23）**。
> 本文档描述了 2026-04-22 完成的第一轮重构：从 MemoryManager 抽出 Memory 接口 +
> 加 legacy / llm-summarizer / mem0 三个平行 adapter。作为历史参考保留。
>
> 遗留问题"memory adapter 自持有 entries 副本（和 narrative_entries 双写）"
> 在那一轮的"非目标"里明确跳过，由 memory-refactor-v2 收敛。

> Status: **Draft v2**（接口定型 + 时序图 + legacy 等价表达）
> Owner: @kawowl
> 创建日期：2026-04-22
> 更新：加入生命周期时序图、章节继承从 Memory 接口移除、pinned 入 section 修复、接口简化

---

## Context

### 当前痛点

1. **`compressFn` 是假的** —— `src/core/game-session.ts:305-310` 里传给 `memory.compress()` 的 compressFn 是:

   ```ts
   entries.map((e) => `[${e.role}] ${e.content.slice(0, 200)}`).join('\n')
   ```

   不调 LLM，只是把每条 entry 截断前 200 字拼起来。`state.summaries[]` 里攒的"摘要"其实是截断原文列表。

2. **`maybeMergeSummaries` 从未运行** —— `memory.compress(compressFn)` 调用时没传第二参数 `mergeFn`，所以 memory.ts:184 里 `if (mergeFn)` 直接跳过。设计的两阶段分层压缩只跑了第一阶段。

3. **`_engine_memory` section 内容质量差** —— 发给 LLM 的 system prompt 里 `---\n[Memory Summary]\n<summaries>\n---` 这段，实际是截断原文拼接。越玩越长，越长越糟。

4. **`query_memory` tool 只有关键词匹配** —— `memory.ts:query()` 是空格分词的词频打分，没有向量搜索，对"含义相近但用词不同"的检索完全不起作用。

5. **耦合过紧** —— `MemoryManager` 是具体类，`game-session.ts` 直接 `new MemoryManager(config)`、直接调 `memory.appendTurn/getAllEntries/getSummaries/restore`。要换实现只能改所有调用点。

### 重构目标

- **抽出 `Memory` 接口**，把"append / retrieve / snapshot / restore"作为稳定契约
- **Legacy 实现**保留现有行为（两阶段压缩 + 截断 compressFn + 关键词 query），作为参考和回退兜底
- **可选：LLMSummarizer 实现** —— legacy 的外壳 + 真 LLM 压缩（本地能跑，质量提升，零外部依赖）
- **Mem0 实现** —— 接 mem0ai 官方 TS SDK，拿到托管的向量检索和自动摘要
- 所有实现**都统一异步接口**（一次性改，避免 sync/async 混杂）
- 通过**配置切换**当前活动的 Memory 实现，不再硬编码

### 非目标

- **不动 `messages[]` 通道的位置**。recent messages 在 step 0 前一次性组装，不迁到 `prepareStep`。理由：
  1. recent messages 在 step 间不变（memory.appendTurn 只在 generate 外部触发）
  2. mem0 等远程 adapter 的 retrieve 延迟对 per-step 敏感
  3. prompt cache 命中依赖前缀稳定
- **不改 `context-assembler.ts` 的 section 组装顺序**。只换 section 内容来源，不换顺序。
- **不做章节继承**。章节切换不是 Memory 的生命周期事件（`executeChapterTransition` 目前本就是死代码）。Memory 不暴露 `finalize` / `setInheritedSummary`，如果外部有"章节切换清空记忆"的需求，显式调 `reset()`。
- **不重写 `signal_input_needed` 的挂起模式**（独立议题）。

---

## 接口设计

### `src/core/memory/types.ts`

```ts
import type { MemoryEntry } from '../types';
import type { ChatMessage } from '../context-assembler';

/**
 * Memory scope —— 绑定到具体的 playthrough
 *
 * 构造时一次性提供，所有 write/retrieve/snapshot 自动绑定到这个 scope，
 * 调用方不重复传。
 *
 * - mem0 adapter 把 playthroughId 映射为 user_id
 * - legacy adapter 忽略 scope（状态全在实例里）
 * - chapterId 是**可选 tag**，不作生命周期信号（上轮决策：章节不是 memory 事件）
 */
export interface MemoryScope {
  playthroughId: string;
  userId: string;
  chapterId?: string;
}

/**
 * 一次 retrieve 的结果
 *
 * - `summary`: 作为 `_engine_memory` section 的文本内容（空字符串表示 section 不出现）
 * - `entries`: 供 query_memory tool 展示给 LLM 的原始条目（可选）
 * - `meta`: adapter 特定的观测信息（mem0 的 relevance score 等），进 trace 用
 */
export interface MemoryRetrieval {
  summary: string;
  entries?: MemoryEntry[];
  meta?: Record<string, unknown>;
}

/**
 * getRecentAsMessages 的返回类型
 */
export interface RecentMessagesResult {
  messages: ChatMessage[];
  tokensUsed: number;
}

/**
 * 快照 —— opaque JSON，由 adapter 自己解释
 *
 * 不同 adapter 的格式不同：
 * - legacy: { kind:'legacy-v1', entries, summaries, watermark }
 * - mem0:   { kind:'mem0-v1', recentEntries }（云端数据不含在 snapshot 里）
 *
 * adapter.restore 要先检 kind 再解包；不认的 kind 抛错。
 */
export type MemorySnapshot = Record<string, unknown>;

/**
 * Memory 抽象接口
 *
 * 所有方法 async。构造时绑 scope，之后读写自动作用到 scope 上。
 *
 * 非职责：
 *   - 不管 state 快照、tool 注册、LLM 调用
 *   - 不管章节边界（章节是 state 事件，不触发 Memory 方法）
 *   - 不参与 prepareStep，AI SDK step 间不会回调到 Memory
 */
export interface Memory {
  readonly kind: string;

  // ─── Write ─────────────────────────────────────────────────────────

  /** 每回合结束后追加一条（receive = 玩家、generate = LLM） */
  appendTurn(entry: MemoryEntry): Promise<void>;

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
   *   由 `game-session.buildRetrievalQuery()` 生成，是一个**刻意保留的
   *   扩展点**：Phase 1 简单返回最近玩家输入；未来可升级为 LLM 根据
   *   当前 state + 叙事动态生成 —— 升级时 Memory 接口完全不动。
   *
   * @param hints adapter 特定的可选参数（topK、过滤条件等）
   */
  retrieve(query: string, hints?: Record<string, unknown>): Promise<MemoryRetrieval>;

  /**
   * 产出 messages[] 通道的 recent history，附带 budget cap。
   *
   * 职责**从 context-assembler 挪进来**：role 翻译（receive→user、
   * generate→assistant）+ token budget break 都封在 adapter 内，
   * assembler 一行调用拿到即刻可用的 ChatMessage[]。
   */
  getRecentAsMessages(opts: { budget: number }): Promise<RecentMessagesResult>;

  // ─── Lifecycle ─────────────────────────────────────────────────────

  /**
   * 让 adapter 决定是否触发内部压缩 / 远端同步 / 清理。
   *
   * 调用时机：每轮 generate 完成后（在 appendTurn + snapshot 的时序里）
   *
   *   - legacy: 查 total tokens > threshold → 真压缩
   *   - llm-summarizer: 同上但 compressFn 走真 LLM
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
 * Factory —— 根据配置构造具体实现
 *
 * 让 game-session 不直接 import adapter 类，解耦配置。
 */
export async function createMemory(options: {
  scope: MemoryScope;
  config: import('../types').MemoryConfig;
  llmClient?: import('../llm-client').LLMClient;  // LLMSummarizer 需要
}): Promise<Memory>;
```

### 目录结构

```
src/core/memory/
  types.ts                       # 新 —— Memory / MemoryScope / MemoryRetrieval / RecentMessagesResult
  factory.ts                     # 新 —— createMemory(config) 根据 kind 分发
  legacy/
    manager.ts                   # 从 src/core/memory.ts 迁过来（简化后）
    compress.ts                  # truncatingCompressFn（从 game-session.ts:305-310 迁过来）
  llm-summarizer/                # Phase 2
    manager.ts                   # 继承 legacy，覆盖 compressFn 走 LLM
  mem0/                          # Phase 3
    adapter.ts                   # 接 mem0ai SDK
    mapping.ts                   # scope → user_id、entry → mem0 message 转换
  index.ts                       # re-export

src/core/
  tokens.ts                      # 新 —— estimateTokens 从 memory.ts 剥出来（被 architect/ui/fixtures 共享）
```

**迁移后**：
- `src/core/memory.ts` **删除**（迁入 `legacy/manager.ts`）
- `game-session.ts:305-310` 的 fallback compressFn **删除**
- 所有 `import { MemoryManager } from './memory'` → `import { Memory } from './memory/types'`
- 所有 `import { estimateTokens } from './memory'` → `import { estimateTokens } from './tokens'`

---

## 生命周期时序

一轮 generate 的完整时间线，以及 Memory 接口每个方法在何时被调用。

```
时间  │ 发生的事                                    │ Memory 接口调用
══════╪════════════════════════════════════════════╪══════════════════════════════════
 T-1  │ WebSocket attach / resume                   │ restore(snapshot)    ← 仅断线重连
      │                                             │
  T0  │ 玩家点了选项或输入文字                      │ appendTurn({receive}) ← submitInput
      │ game-session.submitInput(text)              │
      │                                             │
══════╪════════════════════════════════════════════╪══════════════════════════════════
  T1  │ assembleContext(memory, state, segments, …) │ retrieve(playerInput) ← 产出 _engine_memory
      │ 组装 systemPrompt 和 messages[]             │ getRecentAsMessages({ ← 产出 messages[]
      │                                             │   budget: 剩余 budget
      │                                             │ })
      │                                             │
══════╪════════════════════════════════════════════╪══════════════════════════════════
  T2  │ streamText({ system, messages, tools })     │ (以下由 AI SDK 内部驱动)
      │                                             │
      │  ┌─ Step 0 ─────────────────────────────    │
      │  │ LLM API call 1                           │
      │  │ 输出: text + tool_call(change_scene)     │
      │  │ AI SDK 执行 change_scene.execute()       │ ← 不碰 memory
      │  └──────────────────────────────────────    │
      │                                             │
      │  ┌─ Step 1 ─────────────────────────────    │
      │  │ messages += [assistant, tool_result]     │ ← AI SDK 自己拼
      │  │ LLM API call 2                           │
      │  │ 输出: text + tool_call(pin_memory)       │
      │  │ AI SDK 执行 pin_memory.execute()         │ pin(content, tags)
      │  └──────────────────────────────────────    │
      │                                             │
      │  ┌─ Step 2 ─────────────────────────────    │
      │  │ 输出: text + tool_call(query_memory)     │
      │  │ AI SDK 执行 query_memory.execute()       │ retrieve(query)
      │  └──────────────────────────────────────    │
      │                                             │
      │  ┌─ Step 3 ─────────────────────────────    │
      │  │ 输出: text + tool_call(signal_input_     │
      │  │   needed)                                │
      │  │ ⚠ signal 挂起分支（T3）                  │
      │  └──────────────────────────────────────    │
      │                                             │
══════╪════════════════════════════════════════════╪══════════════════════════════════
  T3  │ signal_input_needed.execute() 挂起前        │ appendTurn({generate,  ← 持久化 buffer
  (可 │ game-session.createWaitForPlayerInput()     │   currentBuffer})
  选) │                                             │ snapshot()             ← onWaitingInput
      │                                             │
      │ [等玩家，几秒到几小时]                      │
      │                                             │
      │ 玩家输入 → Promise resolve                  │ appendTurn({receive,   ← 新 input 进 memory
      │                                             │   playerInput})
      │                                             │
      │ 回到 streamText tool loop 继续 Step 4+      │
      │                                             │
══════╪════════════════════════════════════════════╪══════════════════════════════════
  T4  │ streamText 返回 result                      │
      │ game-session 处理 result                    │ appendTurn({generate,  ← 完整叙事
      │                                             │   result.text})
      │                                             │
  T5  │ persistence.onGenerateComplete              │ snapshot()             ← 写 DB
      │                                             │
  T6  │ compact check                               │ maybeCompact()         ← adapter 自决要不要真压
      │                                             │
══════╪════════════════════════════════════════════╪══════════════════════════════════
  T7  │ emitter.setStatus('waiting-input')          │
      │ (等下一次玩家输入 → 回到 T0)                │
```

### 调用汇总表

| # | 调用者 | 方法 | 频率 | 时机 |
|---|--------|------|------|------|
| 1 | `game-session.resume()` | `restore(snapshot)` | 1 次/session | 断线重连 |
| 2 | `game-session.submitInput()` | `appendTurn({receive})` | 1 次/玩家输入 | T0 |
| 3 | `context-assembler.assembleContext()` | `retrieve(query)` | 1 次/generate | T1 |
| 4 | `context-assembler.assembleContext()` | `getRecentAsMessages({budget})` | 1 次/generate | T1 |
| 5 | `tool-executor` pin_memory.execute | `pin(content, tags)` | 0-N 次/generate | T2 Step 内 |
| 6 | `tool-executor` query_memory.execute | `retrieve(query)` | 0-N 次/generate | T2 Step 内 |
| 7 | `createWaitForPlayerInput` | `appendTurn({generate, buffer})` | 0-1 次（signal 路径） | T3 |
| 8 | `persistence.onWaitingInput` | `snapshot()` | 0-1 次（signal 路径） | T3 |
| 9 | signal resolve 后 | `appendTurn({receive})` | 0-1 次（signal 路径） | T3 |
| 10 | `game-session` generate 完成 | `appendTurn({generate, result.text})` | 1 次/generate | T4 |
| 11 | `persistence.onGenerateComplete` | `snapshot()` | 1 次/generate | T5 |
| 12 | `game-session` generate 完成 | `maybeCompact()` | 1 次/generate | T6 |
| 13 | `game-session.reset()` | `reset()` | 罕见 | 剧本重开 |

### 关键时序约定

- **AI SDK 的 step loop 内部不碰 Memory（除非通过 tool）**。Step N 开始时，AI SDK 自己 append 的是前序 step 的 assistant output + tool results，与 Memory 状态解耦。memory.appendTurn 只在 streamText 外部触发（T0、T3、T4）。
- **retrieve 在 step 内外可能被调多次**，但每次都是幂等读操作，adapter 不能在 retrieve 里埋写逻辑。
- **appendTurn 和 snapshot 严格成对**：正常路径 T4→T5；挂起路径 T3 再加一次对。appendTurn 的实现要防重复写（靠 `currentNarrativeBuffer = ''` 清空标记，保持现有语义）。
- **maybeCompact 只在 T6 触发**。理由：compact 可能调 LLM 耗时几秒，不能阻塞 step loop；memory 在 step 间本就不变，没必要在中间压。
- **Memory 的生命周期事件不绑定 chapter**。章节切换由外层 state 迁移处理，不触发任何 Memory 方法。如果外部希望"章节切换清空记忆"，显式调 `reset()`。

---

## 实现步骤（四阶段）

### Phase 1 — 接口 + Legacy 抽取（预计 1 天，拆 5 个 commit）

**目标**：把现有 `MemoryManager` 等价实现在新接口下，代码行为**几乎零变化**——除一处明确标注的 pre-existing bug 修复（pinned entries 进 `_engine_memory` section）。

#### Commit 1：`estimateTokens` 独立（纯机械、零风险）

- 新建 `src/core/tokens.ts`，把 `estimateTokens` 从 `memory.ts` 剥出来
- 9 处 import 路径替换：`./memory` / `../core/memory` / `../memory` → `./tokens` 等
- 跑 `bun tsc --noEmit` 验证
- commit: `refactor(core): extract estimateTokens to tokens.ts`

被影响的 import 位置（前面 grep 已列全）：
- `src/core/context-assembler.ts:21`
- `src/core/game-session.ts:29`
- `src/core/architect/document-classifier.ts:12`
- `src/core/architect/prompt-splitter.ts:15`
- `src/fixtures/module7-test.ts:30`
- `src/ui/editor/EditorPage.tsx:24`
- `src/ui/editor/PromptPreviewPanel.tsx:17`
- `src/ui/architect/DocumentUpload.tsx:14`
- 自己的定义点：原 `src/core/memory.ts`

#### Commit 2：新接口 + Legacy adapter 等价实现

- 新建 `src/core/memory/types.ts`（接口设计章节内容）
- 新建 `src/core/memory/legacy/manager.ts` —— 完整等价见下
- 新建 `src/core/memory/legacy/compress.ts` —— truncatingCompressFn
- 新建 `src/core/memory/factory.ts`
- 原 `src/core/memory.ts` 暂留不删（双挂，等 Commit 3 切换完再删）
- `MemoryConfig` 加 `provider?` 和 `providerOptions?` 字段
- `chapter-transition.ts` 按前面清单改：删 memory 相关参数、删 L81-92 memory 继承块、`applyTransitionResult` 去掉 `newMemory` 参数
- 跑 `bun tsc --noEmit` 验证
- commit: `feat(memory): add Memory interface + legacy adapter equivalent`

**`src/core/memory/legacy/manager.ts` 完整等价实现**：

```ts
import { estimateTokens } from '../../tokens';
import type { MemoryEntry, MemoryConfig } from '../../types';
import type { ChatMessage } from '../../context-assembler';
import type {
  Memory, MemoryRetrieval, MemorySnapshot, RecentMessagesResult,
} from '../types';

export type CompressFn = (
  entries: MemoryEntry[],
  hints?: string,
) => Promise<string>;

interface LegacyState {
  entries: MemoryEntry[];
  summaries: string[];
  watermark: number;
  // 注意：inheritedSummary 不再保留（章节不再是 memory 生命周期事件）
}

export class LegacyMemory implements Memory {
  readonly kind = 'legacy';
  private state: LegacyState = { entries: [], summaries: [], watermark: 0 };

  constructor(
    private readonly config: MemoryConfig,
    private readonly compressFn: CompressFn,
  ) {}

  // ─── Write ─────────────────────────────────────────────────────────

  async appendTurn(entry: MemoryEntry): Promise<void> {
    this.state.entries.push(entry);
  }

  async pin(content: string, tags?: string[]): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: crypto.randomUUID(),
      turn: this.state.entries.at(-1)?.turn ?? 0,
      role: 'generate',
      content,
      tokenCount: estimateTokens(content),
      pinned: true,
      tags,
    };
    this.state.entries.push(entry);
    return entry;
  }

  // ─── Read ──────────────────────────────────────────────────────────

  /**
   * 等价于：原 getSummaries() ++ pinned entries
   *
   * ⚠ **Pre-existing bug 修复**：原 context-assembler.ts:170-184 只读
   * getSummaries() + getInheritedSummary()，漏掉了 getPinnedEntries()。
   * 现在把 pinned 一并拼进 summary，保证 LLM 调 pin_memory 后的条目
   * 真的出现在 `_engine_memory` section 里。
   *
   * query 参数对 legacy 只影响 entries 字段（关键词匹配），不影响 summary。
   */
  async retrieve(query: string): Promise<MemoryRetrieval> {
    const pinned = this.state.entries.filter((e) => e.pinned);
    const parts: string[] = [];
    for (const s of this.state.summaries) parts.push(s);
    for (const p of pinned) parts.push(`[重要] ${p.content}`);

    return {
      summary: parts.join('\n\n'),
      entries: this.keywordMatch(query).slice(0, 5),
    };
  }

  /**
   * 等价于：原 context-assembler.ts:258-279 的 for 循环 + role 翻译 + budget break
   */
  async getRecentAsMessages(
    opts: { budget: number },
  ): Promise<RecentMessagesResult> {
    const window = this.config.recencyWindow;
    const recent = this.state.entries.slice(-window);

    const messages: ChatMessage[] = [];
    let used = 0;
    for (const e of recent) {
      if (used + e.tokenCount > opts.budget) break;
      messages.push({
        role: e.role === 'receive' ? 'user' : 'assistant',
        content: e.content,
      });
      used += e.tokenCount;
    }
    return { messages, tokensUsed: used };
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  async maybeCompact(): Promise<void> {
    if (this.getTotalTokenCount() <= this.config.compressionThreshold) return;
    await this.compressOnce();
  }

  /**
   * 等价于：原 memory.ts:156-187 的第一阶段
   * （第二阶段 maybeMergeSummaries 在 legacy 下本来就没跑过，这里同样不跑）
   */
  private async compressOnce(): Promise<void> {
    const { recencyWindow, compressionHints } = this.config;
    const pinned = this.state.entries.filter((e) => e.pinned);
    const unpinned = this.state.entries.filter((e) => !e.pinned);
    const toKeep = unpinned.slice(-recencyWindow);
    const toCompress = unpinned.slice(0, -recencyWindow);
    if (toCompress.length === 0) return;

    const summary = await this.compressFn(toCompress, compressionHints);
    this.state.summaries.push(summary);

    const last = toCompress[toCompress.length - 1];
    if (last) this.state.watermark = last.turn;

    this.state.entries = [...pinned, ...toKeep];
  }

  async snapshot(): Promise<MemorySnapshot> {
    return {
      kind: 'legacy-v1',
      entries: this.state.entries,
      summaries: this.state.summaries,
      watermark: this.state.watermark,
    };
  }

  async restore(snap: MemorySnapshot): Promise<void> {
    if (snap.kind !== 'legacy-v1') {
      throw new Error(`LegacyMemory cannot restore from kind: ${snap.kind}`);
    }
    this.state = {
      entries: (snap.entries ?? []) as MemoryEntry[],
      summaries: (snap.summaries ?? []) as string[],
      watermark: (snap.watermark ?? 0) as number,
    };
  }

  async reset(): Promise<void> {
    this.state = { entries: [], summaries: [], watermark: 0 };
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private getTotalTokenCount(): number {
    const entries = this.state.entries.reduce((s, e) => s + e.tokenCount, 0);
    const summaries = this.state.summaries.reduce(
      (s, str) => s + estimateTokens(str),
      0,
    );
    return entries + summaries;
  }

  /** 等价于：原 memory.ts 的 query() 关键词匹配 */
  private keywordMatch(query: string): MemoryEntry[] {
    const keywords = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
    if (keywords.length === 0) return [];
    return this.state.entries
      .map((e) => ({
        e,
        score: keywords.reduce(
          (s, k) => s + (e.content.toLowerCase().includes(k) ? 1 : 0),
          0,
        ),
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.e);
  }
}
```

**`src/core/memory/legacy/compress.ts`**：

```ts
import type { MemoryEntry } from '../../types';
import type { CompressFn } from './manager';

/**
 * 截断拼接 —— 等价于原 game-session.ts:305-310 的 fallback compressFn
 *
 * 注意：这是行为保持用的占位，不是真摘要。Phase 2 LLMSummarizer
 * 会用真 LLM 调用替换这里。
 */
export const truncatingCompressFn: CompressFn = async (entries) => {
  return entries
    .map((e) => `[${e.role}] ${e.content.slice(0, 200)}`)
    .join('\n');
};
```

**`src/core/memory/factory.ts`**：

```ts
import type { Memory, MemoryScope } from './types';
import type { MemoryConfig } from '../types';
import type { LLMClient } from '../llm-client';
import { LegacyMemory } from './legacy/manager';
import { truncatingCompressFn } from './legacy/compress';

export async function createMemory(options: {
  scope: MemoryScope;
  config: MemoryConfig;
  llmClient?: LLMClient;
}): Promise<Memory> {
  const kind = options.config.provider ?? 'legacy';

  switch (kind) {
    case 'legacy':
      return new LegacyMemory(options.config, truncatingCompressFn);
    case 'llm-summarizer':
      throw new Error('Phase 2: LLMSummarizer not implemented yet');
    case 'mem0':
      throw new Error('Phase 3: mem0 adapter not implemented yet');
    default:
      throw new Error(`Unknown memory provider: ${kind}`);
  }
}
```

#### Commit 3：调用点切换

把前面"调用点替换清单"里前端部分全部应用：

- `game-session.ts` 15+ 处：类型改 `Memory`、new 改 factory、所有 `this.memory.xxx()` 加 `await`
- `game-session.ts:305-310` 的 fallback compressFn **删除**
- `game-session.ts:226` 删 `GameSessionConfig.inheritedSummary` 字段
- `game-session.ts:340-341` 删 `setInheritedSummary` 调用
- `context-assembler.ts` L171-184 改为 `await memory.retrieve(query)`
- `context-assembler.ts` L258-279 改为 `await memory.getRecentAsMessages({budget})`
- `context-assembler.ts` 整体改 async，fallback `messages.length === 0` 时塞 initialPrompt 的逻辑**挪到 llm-client.ts**
- `tool-executor.ts` 的 pin/retrieve 加 `await`
- `chapter-transition.ts` 按前面清单改：删 memory 相关
- `types.ts` 删 `MemoryState.inheritedSummary`、`InheritanceSnapshot.summary`
- 删除 `src/core/memory.ts`
- 跑 `bun tsc --noEmit` + `cd server && bun test` 全绿
- commit: `refactor(memory): switch call sites to new Memory interface + remove chapter memory inheritance`

**context-assembler 里 currentQuery 的来源（方案 a + 扩展点）**

query 生成策略按**三层分离**设计，让此刻最简单、未来可演化：

| Layer | 职责 | 当前 | 未来 |
|-------|------|------|------|
| `Memory.retrieve(query)` | 接受 string，空串合法 | 稳定 | 不变 |
| `assembleContext({currentQuery})` 参数 | 从外部接收 query，不自生 | 稳定 | 不变 |
| `game-session.buildRetrievalQuery()` | 决定 query 值 | 返回最近玩家输入 | 可改为 LLM 动态生成 / 拼 state / 多 query 等 |

`game-session.ts` 新增字段 + 方法：

```ts
/**
 * 最近一次玩家输入 —— 作为 Memory.retrieve 的 default query 来源。
 *
 * 由 submitInput 写入，在下一次 assembleContext 时被 buildRetrievalQuery 读取。
 * 挂起路径（signal_input_needed）的玩家输入也在 submitInput 里统一更新。
 */
private lastPlayerInput: string = '';

/**
 * 为本轮 generate 构造 Memory.retrieve 的 query。
 *
 * Phase 1 版本：直接返回最近一次玩家输入。
 *
 * ⚠ 这里故意留一个扩展点。未来可能升级为：
 *   - 用便宜 LLM 根据当前 state + 最近 N 轮叙事生成检索 query
 *   - 拼接 state 里关键变量（角色名、场景、物品）作为 query
 *   - 多 query 并行 retrieve 合并结果
 *
 * 升级时只改这个函数，assembleContext / Memory.retrieve 完全不动。
 *
 * **不要**把这个生成逻辑内联到 assembleContext 调用处 —— 扩展点的
 * 价值就是"一个函数管所有 query 策略"。
 */
private async buildRetrievalQuery(): Promise<string> {
  return this.lastPlayerInput;
}
```

`submitInput(text)` 里加一行 `this.lastPlayerInput = text;`（挂起路径和正常路径的 submit 入口同一个）。

`assembleContext` 调用点：

```ts
const context = await assembleContext({
  segments: this.segments,
  stateStore: this.stateStore,
  memory: this.memory,
  tokenBudget: this.tokenBudget,
  initialPrompt: this.initialPrompt,
  currentQuery: await this.buildRetrievalQuery(),  // ← 扩展点入口
  assemblyOrder: this.assemblyOrder,
  disabledSections: this.disabledSections,
});
```

**边界场景**：
- 首轮（玩家还没 submit）：`lastPlayerInput = ''` → 空 query → adapter 按契约兜底
- Resume 后第一轮：lastPlayerInput 从 lastPlayerInput 字段**不恢复**（它不在 snapshot 里），空 query 兜底；将来如果要"resume 后保持 query 上下文"，在 Layer 3 里查 memory snapshot 即可，接口不变

#### Commit 4：DB schema 合并

- migration `0005_memory_snapshot.sql`：
  ```sql
  ALTER TABLE playthroughs ADD COLUMN memory_snapshot JSONB;

  UPDATE playthroughs SET memory_snapshot = jsonb_build_object(
    'kind', 'legacy-v1',
    'entries', COALESCE(memory_entries, '[]'::jsonb),
    'summaries', COALESCE(memory_summaries, '[]'::jsonb),
    'watermark', 0
  );

  ALTER TABLE playthroughs DROP COLUMN memory_entries;
  ALTER TABLE playthroughs DROP COLUMN memory_summaries;
  ```
- `server/src/db/schema.ts` L241-242 合并为 `memorySnapshot: jsonb('memory_snapshot').$type<MemorySnapshot | null>()`
- `playthrough-service.ts` / `playthrough-persistence.ts` / `session-manager.ts` 把 `memoryEntries + memorySummaries` 改为 `memorySnapshot`
- 测试 fixture 同步（~10 处）
- 跑 `cd server && bun test` 全绿
- commit: `feat(memory): merge memory_entries + memory_summaries into memory_snapshot JSONB`

#### Commit 5：启动 smoke + Langfuse 对比

- `cd server && bun start`
- 开一个现有 playthrough 继续玩 2-3 轮
- 对比 Langfuse trace 里的 `_engine_memory` section：
  - **原有 summaries 部分**：字节级一致
  - **Pinned entries 部分**：新增 `[重要] ...` 行（这是主动修复的 pre-existing bug）
- 对比 `messages[]` 通道：字节级一致
- 对比 `query_memory` tool 的返回：结构从 `entries[]` 改为 `{summary, entries}`，LLM 能正确消费
- commit: `chore(memory): Phase 1 smoke verified`

#### Phase 1 验收标准

- [x] `bun tsc --noEmit`（前端）+ `cd server && bun test` 全绿
- [x] 现有 playthrough 能 resume、继续玩、写回 DB
- [x] `_engine_memory` section 内容 ≈ 重构前，**除了 pinned entries 现在会出现**（标注为 bug 修复）
- [x] `messages[]` 通道内容字节级一致
- [x] 压缩触发时 summaries 追加，行为和重构前一致（还是截断拼接）
- [x] 全部 commit 独立可跑

## Legacy 等价表达的方法映射（速查）

| 原方法（memory.ts） | 新接口位置 | 行为等价说明 |
|---------------------|-----------|-------------|
| `appendTurn(entry)` | `LegacyMemory.appendTurn` | 1:1 迁移，加 async |
| `getRecent(n?)` | **不再暴露**；`getRecentAsMessages` 内部使用 | 移除原因：外部只需要转换后的 messages，不需要原 entry |
| `getSummaries()` | 合并进 `retrieve().summary` | summary 字段包含原 summaries + pinned |
| `getPinnedEntries()` | **删除**；pinned 内部并进 `retrieve().summary` | 原方法只被 chapter-transition 用，删 |
| `getInheritedSummary()` | **删除** | 章节不再是 memory 事件 |
| `getAllEntries()` | `snapshot().entries` 取出 | 外部取"全部原文"只为持久化，走 snapshot 即可 |
| `pin(content, tags)` | `LegacyMemory.pin` | 1:1，加 async |
| `query(query)` | `retrieve(query).entries` | `query_memory` tool 现在读 entries 字段 |
| `needsCompression()` | **变私有**；`maybeCompact()` 内部判断 | 外部不再直接查阈值 |
| `compress(compressFn, mergeFn?)` | `maybeCompact()` + `private compressOnce()` | compressFn 由构造注入不再外传，mergeFn 本就没用过一起砍 |
| `compressAll(compressFn)` | **删除** | 只被 chapter-transition 用，删 |
| `setInheritedSummary(s)` | **删除** | 章节不再是 memory 事件 |
| `reset()` | `LegacyMemory.reset` | 1:1，加 async |
| `restore(entries, summaries)` | `LegacyMemory.restore(snapshot)` | 签名变 opaque snapshot，内部逻辑不变 |

**关键行为对比**：

| 行为 | 重构前 | 重构后 | 等价吗 |
|------|-------|-------|--------|
| 每轮写 memory | `this.memory.appendTurn({...})` | `await this.memory.appendTurn({...})` | ✅ |
| `_engine_memory` 内容 - summaries 部分 | 有 | 有 | ✅ |
| `_engine_memory` 内容 - inheritedSummary 部分 | 有（如果设过） | **无** | ❌ 主动移除 |
| `_engine_memory` 内容 - pinned entries 部分 | **无**（pre-existing bug） | 有 | 🟢 主动修复 |
| `messages[]` 内容 | 原文 N 条 | 原文 N 条 | ✅ |
| 关键词 query | 有 | 有 | ✅ |
| 压缩（截断拼接） | 有 | 有 | ✅ |
| 压缩阈值判断 | `needsCompression()` 查 | `maybeCompact()` 内部查 | ✅ |
| 两阶段压缩的第二阶段 | 从未运行 | 从未运行 | ✅ |
| DB 格式 | `memory_entries` + `memory_summaries` 两列 | `memory_snapshot JSONB` 单列 | ✅ 通过 migration 无感迁移 |
| 章节继承 memory | 有代码但死代码（never called） | 代码删掉 | ✅ |

---

### Phase 2 — 真 LLMSummarizer 实现（预计半天）

**目标**：用真 LLM 调用替换截断 compressFn，`_engine_memory` 质量立即提升，不引入外部服务。

#### 2.1 创建 `src/core/memory/llm-summarizer/manager.ts`

```ts
export class LLMSummarizerMemory extends LegacyMemory {
  readonly kind = 'llm-summarizer';
  private llmClient: LLMClient;

  constructor(config: MemoryConfig, llmClient: LLMClient) {
    // 构造时不传 truncatingCompressFn，用自己的
    super(config, (entries, hints) => this.llmCompress(entries, hints));
    this.llmClient = llmClient;
  }

  private async llmCompress(entries: MemoryEntry[], hints?: string): Promise<string> {
    const transcript = entries.map((e) =>
      `${e.role === 'receive' ? '玩家' : '旁白'}：${e.content}`
    ).join('\n\n');

    const result = await this.llmClient.generate({
      systemPrompt: `你是剧情摘要助手。把下面的对话浓缩成 3-5 句话的情节摘要，保留：
- 关键剧情事件
- 角色情绪/关系变化
- 重要的选择和后果
${hints ? `\n特别关注：${hints}` : ''}`,
      messages: [{ role: 'user', content: transcript }],
      tools: {},
      maxOutputTokens: 512,
    });

    return result.text;
  }
}
```

同理实现 `mergeFn`（合并已有摘要时用），调用 `compress(compressFn, mergeFn)` 开启两阶段压缩。

#### 2.2 factory 注册

```ts
case 'llm-summarizer':
  if (!options.llmClient) throw new Error('llm-summarizer requires llmClient');
  return new LLMSummarizerMemory(options.config, options.llmClient);
```

#### 2.3 `game-session.ts` 传 llmClient

```ts
this.memory = await createMemory({
  scope: {...},
  config: config.memoryConfig,
  llmClient: this.llmClient,  // 新增
});
```

#### 2.4 配置 / 切换

- 当前默认仍为 `legacy`，不改全局默认
- 编辑器 `ScriptInfoPanel` 加个 `memoryConfig.provider` dropdown（legacy / llm-summarizer / mem0），值存进 manifest
- 验证：用测试剧本把 provider 切 llm-summarizer，观察 Langfuse 里 `_engine_memory` section 的内容从"截断拼接"变成真正的 3-5 句摘要
- 验证：`maxOutputTokens=512` 之下 compression 成本可控（估算：每次触发 compression 多一次短 LLM 调用，每小时剧情约触发 1-2 次）

#### 2.5 commit

`feat(memory): add LLMSummarizer implementation for real compression`

---

### Phase 3 — mem0 adapter（预计 2-3 天）

**目标**：接入 mem0 的向量检索 + 托管摘要，不用自己维护 embedding 和存储。

> 前置确认（用户 Q7）：**mem0 Platform（云服务，`https://api.mem0.ai`）不需要配 collection / llmModel / embeddingModel，全由 mem0 托管**。我们只需要 `MEM0_API_KEY`。如果改成 self-hosted 再考虑这些。

#### 3.1 依赖

```json
// server/package.json
{
  "dependencies": {
    "mem0ai": "^2.x.x"  // 官方 TypeScript SDK
  }
}
```

Environment：
```
MEM0_API_KEY=xxx
```

#### 3.2 创建 `src/core/memory/mem0/adapter.ts`

```ts
import MemoryClient from 'mem0ai';
import type { Memory, MemoryScope, MemoryRetrieval } from '../types';

export class Mem0Memory implements Memory {
  readonly kind = 'mem0';
  private client: MemoryClient;
  private scope: MemoryScope;
  private config: MemoryConfig;
  /** 短期滑动窗口（原文），mem0 不负责这部分 */
  private recentEntries: MemoryEntry[] = [];
  /** 继承的摘要 */
  private inheritedSummary?: string;

  constructor(scope: MemoryScope, config: MemoryConfig) {
    this.scope = scope;
    this.config = config;
    this.client = new MemoryClient({ apiKey: process.env.MEM0_API_KEY! });
  }

  async appendTurn(entry: MemoryEntry): Promise<void> {
    this.recentEntries.push(entry);
    // 每 N 轮批量上传到 mem0 —— 既不每条一请求（太慢），也不全积累（断线会丢）
    if (this.recentEntries.length % 5 === 0) {
      await this.flushToMem0();
    }
  }

  private async flushToMem0(): Promise<void> {
    const toUpload = this.recentEntries.slice(-10);  // 最后 10 条
    await this.client.add(
      toUpload.map((e) => ({
        role: e.role === 'receive' ? 'user' : 'assistant',
        content: e.content,
      })),
      {
        user_id: this.scope.playthroughId,
        metadata: {
          chapterId: this.scope.chapterId,
          turn: toUpload[toUpload.length - 1].turn,
        },
      },
    );
  }

  async retrieve(query: string, hints?: { topK?: number }): Promise<MemoryRetrieval> {
    const topK = hints?.topK ?? 10;
    const results = await this.client.search(query, {
      user_id: this.scope.playthroughId,
      limit: topK,
    });

    // mem0 返回的是"相关记忆条目"数组，每条已是摘要过的
    const summaryParts: string[] = [];
    if (this.inheritedSummary) {
      summaryParts.push(`[Previous Chapter Summary]\n${this.inheritedSummary}`);
    }
    if (results.length > 0) {
      summaryParts.push('[Relevant Memories]');
      for (const r of results) {
        summaryParts.push(`- ${r.memory}`);
      }
    }

    return {
      summary: summaryParts.join('\n\n'),
      meta: { relevanceScores: results.map((r) => r.score) },
    };
  }

  async getRecent(n?: number): Promise<MemoryEntry[]> {
    const window = n ?? this.config.recencyWindow;
    return this.recentEntries.slice(-window);
  }

  async pin(content: string, tags?: string[]): Promise<MemoryEntry> {
    // mem0 的 memories 没有 pinned 概念，只能用 metadata 标记
    await this.client.add(
      [{ role: 'system', content }],
      {
        user_id: this.scope.playthroughId,
        metadata: { pinned: true, tags: tags ?? [] },
      },
    );
    return {
      id: crypto.randomUUID(),
      turn: 0,
      role: 'generate',
      content,
      tokenCount: estimateTokens(content),
      pinned: true,
      tags,
    };
  }

  async finalize(): Promise<string> {
    // 跨章节：把当前 playthrough 所有 memory 搜一次（query 空 → 拿全部）
    const all = await this.client.getAll({ user_id: this.scope.playthroughId });
    return all.map((m) => m.memory).join('\n\n');
  }

  async maybeCompact(): Promise<void> {
    // mem0 自动做去重/合并，外层不需要触发
    if (this.recentEntries.length > 0) {
      await this.flushToMem0();
    }
  }

  async snapshot(): Promise<MemorySnapshot> {
    return {
      kind: 'mem0-v1',
      recentEntries: this.recentEntries,
      inheritedSummary: this.inheritedSummary,
      // mem0 数据在云端，本地只存短期窗口 + 继承摘要
    };
  }

  async restore(snap: MemorySnapshot): Promise<void> {
    if (snap.kind !== 'mem0-v1') throw new Error(...);
    this.recentEntries = (snap.recentEntries ?? []) as MemoryEntry[];
    this.inheritedSummary = snap.inheritedSummary as string | undefined;
  }

  async setInheritedSummary(summary: string): Promise<void> {
    this.inheritedSummary = summary;
  }

  async reset(): Promise<void> {
    // 清 mem0 云端
    await this.client.deleteAll({ user_id: this.scope.playthroughId });
    this.recentEntries = [];
    this.inheritedSummary = undefined;
  }
}
```

#### 3.3 关键决策记录（待开工时确认）

- **user_id 用 playthroughId 而非 userId**：一个 user 玩多个剧本 / 多个 playthrough，记忆必须严格隔离。用 playthroughId 能保证切 playthrough 时记忆不串。
- **短期窗口 recentEntries 仍由 adapter 本地维护**：`messages[]` 通道要的是严格的时序最近 N 条，mem0 的 retrieval 是相关度排序，语义不同
- **flushToMem0 的频率**：每 5 轮批量一次。代价是断线会丢最后 ≤4 轮没上传的数据 —— 但这些数据还在 recentEntries 里，snapshot 时会写进 DB，重连恢复时再次进入 flush 队列。不会丢。
- **删除语义**：reset() 调 `deleteAll` 真的从 mem0 云端删。重开剧本不是重置 playthrough（重开是新 playthrough，新 user_id），所以 reset() 主要用于测试。
- **冷启动**：空 mem0 状态下 retrieve 返回空数组，summary = inheritedSummary（如果有）或空字符串 → `_engine_memory` section 不出现。OK。

#### 3.4 factory 注册

```ts
case 'mem0':
  if (!process.env.MEM0_API_KEY) throw new Error('MEM0_API_KEY not set');
  return new Mem0Memory(options.scope, options.config);
```

#### 3.5 `game-session.ts` 传 scope

```ts
this.memory = await createMemory({
  scope: {
    playthroughId: config.playthroughId,
    userId: config.userId,
    chapterId: config.currentChapterId,
  },
  config: config.memoryConfig,
  llmClient: this.llmClient,
});
```

#### 3.6 验收

- Env 有 `MEM0_API_KEY`，启动后端 ok
- 在编辑器把某剧本的 `memoryConfig.provider` 切成 mem0，试玩
- Langfuse trace 里 `_engine_memory` section 显示 `[Relevant Memories]` 列表
- 玩 ~20 回合，断线重连 → 恢复 OK
- 开新 playthrough → retrieve 结果不串
- commit: `feat(memory): add mem0 adapter with vector retrieval`

---

### Phase 4 — Memory Bench（🅿 已拆出作为独立 task，暂缓）

**Status**: Deferred —— Phase 1-3 已收尾，此 Phase 作为独立 QA 任务后续再做。
**目标**：在同一段剧本上跑三种 provider（legacy / llm-summarizer / mem0），对比输出质量，产出 `docs/memory-bench.md` 决策报告。

#### 4.1 准备基准剧本

用 `fixtures/module7-test.ts` 或现有的 "咖啡馆测试剧本"，至少 30 回合剧情。

#### 4.2 三路跑

- 同一初始 playthrough 参数、同一 LLM config
- 每种 provider 跑一遍，各生成一条 playthrough
- 关键轮次记录 `_engine_memory` section 的内容快照

#### 4.3 对比维度

| 维度 | legacy | llm-summarizer | mem0 |
|------|--------|----------------|------|
| `_engine_memory` token 占用 | 高（线性增长） | 中（摘要后恒定） | 中（topK 恒定） |
| 30 回合后 LLM 能否正确引用早期剧情 | 差（截断） | 中（摘要） | 好（相关检索） |
| 每轮 API 成本 | 0 额外 | +1 短 LLM 调用（偶发） | +1 mem0.add + retrieve |
| 断线恢复 | 快 | 快 | 慢（需 fetch） |

#### 4.4 产出

在 `docs/memory-comparison.md` 写对比报告，附关键 trace 链接 + token 数据。决定默认 provider（目前倾向 llm-summarizer，mem0 作为可选升级）。

---

## 验证清单

- [ ] Phase 1 完成，所有现有测试通过
- [ ] Phase 2 完成，`_engine_memory` section 内容从截断拼接变为真摘要
- [ ] Phase 3 完成，mem0 接入成功，retrieve 返回有 relevance score
- [ ] Phase 4 完成，对比报告写完
- [ ] 老 playthrough 数据通过 migration 正确映射到新 snapshot 格式
- [ ] `query_memory` tool 在三种 provider 下都能正常工作
- [ ] Langfuse trace 里 `kind` 字段标识清楚当前 provider

---

## 风险 & 遗留

- **async 改动面广**：context-assembler 改 async 会影响所有调用方（game-session、PromptPreviewPanel 预览）。需要一次性扫一遍所有同步调用点。
- **snapshot 格式迁移**：现有 playthroughs 表 `memory_entries` + `memory_summaries` 两列要合并到 `memory_snapshot JSONB`。migration 需要 `UPDATE` 语句做一次性回填，跑前备份 DB。
- **mem0 数据和 playthrough 解耦**：删一个 playthrough 时要同步调 `mem0.deleteAll({user_id: playthroughId})`，否则 mem0 云端积累孤儿数据。这个要在 `playthrough-service.delete()` 里加 hook。
- **mem0 API 限额 / 延迟**：每轮 retrieve 至少 +200ms。考虑给 retrieve 加超时兜底（失败时返回空 summary，不阻断 generate）。
- **LLMSummarizer 的 compressFn 失败处理**：LLM 调用可能失败，当前设计是抛异常。可能要 wrap 成"失败时回退到 truncatingCompressFn"，保证 generate 不被一次压缩失败拖死。

## 相关 backlog（不在本 plan 范围内）

- `signal_input_needed` 挂起 → 立即 ack + hasToolCall 终止 的状态机简化
- `query_changelog` / `read_state` / `query_memory` 的合并（减少 tool 数量）
- Memory 的"写后台、读热路径"异步化（retrieve 阻塞 generate 启动的延迟优化）
