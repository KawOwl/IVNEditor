# Messages 数据模型重构（方案 B 前置）

> Status: **Draft**（2026-04-23）
> 触发: `turn-bounded-generate.md` 方案 B 需要"跨 generate() 重建 messages 历史"，暴露出当前
>   messages 数据模型未系统化设计
> 前置: `conversation-persistence.md` Step 1-4（signal_input / player_input entry 事件化）已上线
> 后续: `turn-bounded-generate.md` 方案 B 实施计划（基于本文档的 messages-builder）

---

## 为什么做这件事

方案 B 的核心改动是 **每个玩家回合 = 一次独立的 `generate()` 调用**。配套需求是每次新 generate
前能把历史 messages 完整重建出来喂给 LLM。

当前架构里不存在独立的 "messages 数据模型"：
- `memory.getRecentAsMessages()` 把 `memory_snapshot.entries`（role/content 字符串对）翻译成
  `ChatMessage[]` —— 纯 text，没有 tool_use/tool_result 结构
- 挂起模式下一次 generate() 跨整局，AI SDK 自己在 step 间维护 tool 结构，generate() 返回后
  这些信息就丢了
- `narrative_entries` 是对话真相来源，但之前只存了 narrative / signal_input / player_input 三类，
  其他 tool 调用不持久化

方案 B 下切断 generate() 边界后，LLM 下次启动需要看到 "上回合我问了 A/B/C、玩家选了 B" 这类
信息 —— 必须结构化存储 + 视图层重建。

---

## 设计原则

### 1. Canonical Source

`narrative_entries` 是对话历史的唯一真相。任何需要"对话发生了什么"的模块（UI backlog / LLM
messages / memory retrieval）都从它派生，不独立保存副本。

### 2. 持久化原粒度

每次语义事件产生时写一条独立 entry，**不在写入时做任何合并**。合并操作只属于视图层。

| 事件 | 粒度 |
|---|---|
| LLM 在一次 step 里吐 3 段 narrative（段落切分 / signal flush / generate 返回 flush） | 3 条 narrative entry |
| LLM 并行调 [update_state, change_scene, signal_input_needed] | 3 条 entry，共享 batchId |
| 玩家一次提交（未来可能多模态多 part） | 独立 batchId 下 1+ 条 entry |

### 3. 视图层派生、可重建

两类视图都是纯函数从 entries 推导：
- `messages-builder` → `ModelMessage[]` → 喂 LLM（**由 memory adapter 内部使用**）
- `NarrativeParser` → `Sentence[]` → 喂 UI backlog

丢掉任何视图层 cache 不影响系统正确性（最多重算一次）。

### 4. 不 normalize `content` 原文

- `narrative.content` 是 LLM 吐的 XML-lite 原文（含 `<d>` 标签），byte-for-byte 保留
- 视图层需要时各自 parse（LLM 看原文 / UI 解析成 dialogue Sentence）

### 5. `assembleContext` 作为 LLM context 唯一组装入口

coreLoop / game-session 不直接调 `messages-builder` 或 `NarrativeHistoryReader`。
上下文装配的职责分层：

```
NarrativeHistoryReader  (读 entries 的接口)
     ↑ 被 memory adapter 内部用
Memory Adapter  (legacy / mem0 / LLMSummarizer)
     内部用 messages-builder + reader 做分层策略（最近结构化 + 更早摘要）
     ↑ 暴露 getRecentAsMessages / retrieve 给 assembleContext
assembleContext  (唯一组装入口)
     组合 system prompt sections + messages 通道
     ↑ 被 coreLoop 调用
coreLoop / game-session
```

messages-builder 和 reader 在 M1 里作为**独立工具 + 单元测试**落地，暂不挂进任何 adapter，
也不从 coreLoop 调。真正接入发生在未来 memory adapter refactor。

---

## 持久化层 · `narrative_entries` 扩展

### Schema（migration 0011）

```sql
-- 0011_messages_model.sql

-- (a) 放开 kind 枚举到 4 种：narrative / signal_input / tool_call / player_input
--     没有 DB 层约束（text 列），靠 TS 类型 + 应用层校验收口
-- (b) 加 batch_id：同一 LLM step（或玩家一次提交）产出的 entries 共享

ALTER TABLE "narrative_entries"
  ADD COLUMN "batch_id" text;

CREATE INDEX "idx_narrative_entries_batch_id"
  ON "narrative_entries" ("playthrough_id", "batch_id");
```

**老数据兼容**：`batch_id` nullable，0010 产出的 entries batchId=null，视图层按启发式兜底分组
（player_input 作为 turn boundary）。

### kind 全集

| kind | role | `content` 语义 | `payload` 语义 |
|---|---|---|---|
| `narrative` | `generate` | XML-lite 原文 | `null` |
| `signal_input` | `system` | prompt_hint 文本 | `{ choices: string[] }` |
| `tool_call` | `system` | toolName（如 `"update_state"`） | `{ input: unknown, output: unknown }` |
| `player_input` | `receive` | 玩家输入文本 | `{ selectedIndex?: number, inputType: 'choice' \| 'freetext' }` |

`content` 字段语义对齐：对所有 kind 都承担"一眼能看出这是什么"的人类可读标识。

### batchId 语义

`batchId` 是**分组标记**，不自带时序信息（orderIdx 才是）。

**生成规则**：

| 写入时机 | batchId 值 |
|---|---|
| LLM step 开始时（`experimental_onStepStart` 触发） | 生成新 UUID，本 step 内所有 tool_call / signal_input / narrative entry 挂它 |
| 玩家一次提交 | 独立 UUID，提交对应的 1+ 条 player_input entry 挂它 |
| narrative flush（非 step-边界触发，比如段落切分） | 挂当前 step 的 UUID（step 内写的都是同一 batch） |

**说明**：
- Player_input 独立 batch 是为了未来多模态（文本 + 图片 + 选项 mix）一次提交时，
  schema 层面已经兼容
- narrative 在 step 内可能被多次 flush（段落切分 / signal 挂起前 / generate 返回时 flush），
  它们共享当前 LLM step 的 batchId，视图层合并成一个 text block

### payload 约束（应用层，不在 DB 层）

```ts
// src/core/persistence-entry.ts（新文件，定义 TS 类型和类型守卫）

export type EntryKind = 'narrative' | 'signal_input' | 'tool_call' | 'player_input';

export interface NarrativeEntry {
  id: string;
  playthroughId: string;
  role: 'generate' | 'system' | 'receive';
  kind: EntryKind;
  content: string;
  payload: NarrativePayload | null;
  batchId: string | null;
  orderIdx: number;
  reasoning?: string | null;
  finishReason?: string | null;
  createdAt: Date;
}

export type NarrativePayload =
  | { /* narrative: payload = null */ }
  | { choices: string[] }                                           // signal_input
  | { input: unknown; output: unknown }                             // tool_call
  | { selectedIndex?: number; inputType: 'choice' | 'freetext' };  // player_input

// 类型守卫
export function isSignalInputEntry(e: NarrativeEntry): e is NarrativeEntry & { payload: { choices: string[] } } { ... }
export function isToolCallEntry(e: NarrativeEntry): e is NarrativeEntry & { payload: { input: unknown; output: unknown } } { ... }
// ...
```

---

## 视图层 · `messages-builder`

### 签名

```ts
// src/core/messages-builder.ts（新文件）

import type { ModelMessage } from 'ai';  // AI SDK v6 类型
import type { NarrativeEntry } from './persistence-entry';

export interface BuildMessagesOptions {
  /** 对 tool_call entry 里 output 的序列化器（默认 JSON.stringify） */
  serializeToolOutput?: (output: unknown) => string;
}

/**
 * 把 narrative_entries 序列投影成 ModelMessage[]。
 *
 * 前置：entries 已按 orderIdx 升序。
 * 返回：messages 按 LLM 认知的时序排列，可直接喂 streamText({messages})。
 */
export function buildMessagesFromEntries(
  entries: NarrativeEntry[],
  opts?: BuildMessagesOptions,
): ModelMessage[]
```

### 分组与合并规则（batchId 版）

```
1. 按 batchId 把 entries 切成若干 group（batchId 相同的连续 entries 一组）
2. batchId=null 的 entry（老数据兼容）：
     - player_input entry 自成 group（turn boundary）
     - 连续 signal_input / narrative entries 合并成一组，遇到 player_input 切分
3. 每个 group 根据 kind 组合判定是 LLM step group 还是 player input group：
     - 包含 narrative / signal_input / tool_call → LLM step group
     - 仅 player_input → player input group
4. 投影：
     - LLM step group → 一条 assistant message + 紧跟的 tool-role message
     - player input group → 一条 user message（未来多模态时可能拆成多个 content parts）
```

### LLM step group → assistant message

对 group 内 entries 按 orderIdx 排序后：

```ts
assistant.content = [
  // a) 连续 narrative 合并成一个 text block（用 '' 直接拼接，保留原空白 / 换行 / XML 标签）
  { type: 'text', text: concatNarratives(group) },

  // b) 所有 tool_call entries 依次成 tool-call block
  ...toolCallEntries.map(e => ({
    type: 'tool-call',
    toolCallId: e.id,           // 用 entry.id 当 AI SDK 的 toolCallId，保证唯一且稳定
    toolName: e.content,        // content 字段就是 toolName
    input: (e.payload as { input: unknown }).input,
  })),

  // c) signal_input entry 作为一个特殊 tool-call block（toolName='signal_input_needed'）
  ...(signalInputEntry ? [{
    type: 'tool-call',
    toolCallId: signalInputEntry.id,
    toolName: 'signal_input_needed',
    input: {
      prompt_hint: signalInputEntry.content,
      choices: (signalInputEntry.payload as { choices: string[] }).choices,
    },
  }] : []),
]
```

### LLM step group → tool-role message

紧跟 assistant message 的 tool-role message 包含 **所有** 本 step tool_use 的 tool-result：

```ts
tool.content = [
  // 所有 tool_call entries 的 output
  ...toolCallEntries.map(e => ({
    type: 'tool-result',
    toolCallId: e.id,
    toolName: e.content,
    output: { type: 'json', value: (e.payload as { output: unknown }).output },
  })),

  // signal_input 的 tool-result 固定是 { success: true }（挂起模式下实际如此；
  // 方案 B record-only 也返回 success:true）
  ...(signalInputEntry ? [{
    type: 'tool-result',
    toolCallId: signalInputEntry.id,
    toolName: 'signal_input_needed',
    output: { type: 'json', value: { success: true } },
  }] : []),
]
```

### Player input group → user message

```ts
{ role: 'user', content: playerEntries[0].content }
```

（多 entry 多模态情况未来扩展：`content` 变成 `UserContent[]` 数组。本期保持 string 路径。）

### 特殊情况

- **空 entries**：返回 `[]`
- **group 内只有 narrative、没有 tool_call / signal_input**（LLM 自然停止 / maxSteps 击中
  natural stop）：输出 assistant 的 text message，**不生成 tool-role message**
- **group 以 signal_input 开头、没有 narrative**：assistant 只含 tool-call block（无 text）
- **batchId 为 null 的 signal_input 和 narrative 紧邻**（老数据）：启发式合并成同 group
- **两个连续 player_input**（不常见但合法）：各自 user message

---

## 运行时接入 · tool 观察 + batchId 管理

### 做法 B：LLM client 层统一观察

所有 tool_call 持久化在 `src/core/llm-client.ts` 的 `streamText()` 回调里做，**不侵入 tool 定义**：

```ts
// src/core/llm-client.ts（伪代码增量）

let currentBatchId: string | null = null;

const result = streamText({
  model, system, messages, tools,
  stopWhen: [stepCountIs(maxSteps) /* 方案 B 里加 hasToolCall(...) */],

  experimental_onStepStart: () => {
    currentBatchId = crypto.randomUUID();
  },

  experimental_onToolCallFinish: async (event) => {
    const toolName = event.toolCall.toolName;

    // signal_input_needed 单独路径（写 kind='signal_input'，见下节）
    if (toolName === 'signal_input_needed') return;

    await persistence?.onToolCallRecorded?.({
      toolName,
      input: event.toolCall.args,
      output: event.toolResult.result,
      batchId: currentBatchId!,
    });
  },

  experimental_onStepFinish: () => {
    currentBatchId = null;  // step 结束清空
  },
});
```

### signal_input_needed 的特殊路径

signal_input_needed 的 **语义**（GM 暂停向玩家提问）和其他 tool 不同 —— 它的 input 本身就是
要展示给玩家的内容。现有 Step 2 的 `onSignalInputRecorded({hint, choices})` 继续保留，挂当前
batchId：

```ts
// game-session.ts createWaitForPlayerInput（方案 B 前）
if (hint) {
  await this.persistence?.onSignalInputRecorded?.({
    hint,
    choices,
    batchId: currentBatchId,   // ← 新增
  });
}
```

（方案 B 后 signal_input_needed.execute 改 record-only，这个调用从 tool-executor 直接触发，
逻辑一致。）

### player_input 的 batchId

每次玩家提交时独立生成 UUID：

```ts
// game-session.ts submitInput (方案 B 简化后)
async submitInput(text: string) {
  const playerBatchId = crypto.randomUUID();
  await this.persistence?.onReceiveComplete({
    ...
    batchId: playerBatchId,
    payload: computeReceivePayload(text, choices),
  });
  ...
}
```

### SessionPersistence 接口变化（增量）

```ts
// src/core/game-session.ts 的 SessionPersistence 扩展

interface SessionPersistence {
  // 现有的 onNarrativeSegmentFinalized / onSignalInputRecorded / onReceiveComplete
  // 都加 batchId 字段（optional，兼容现阶段挂起模式）

  onNarrativeSegmentFinalized(data: {
    entry: { role; content; reasoning?; finishReason? };
    batchId?: string;  // ← 新增（方案 B 前挂起模式下可为 null）
  }): Promise<void>;

  onSignalInputRecorded?(data: {
    hint: string;
    choices: string[];
    batchId?: string;  // ← 新增
  }): Promise<void>;

  onReceiveComplete(data: {
    entry; stateVars; turn; memorySnapshot;
    payload?: ...;
    batchId?: string;  // ← 新增
  }): Promise<void>;

  /** 新增：每次 tool_call 完成时调用 */
  onToolCallRecorded?(data: {
    toolName: string;
    input: unknown;
    output: unknown;
    batchId: string;
  }): Promise<void>;
}
```

Server 端 `playthrough-persistence.ts` 各实现里把 batchId 透传到 `appendNarrativeEntry`。
`appendNarrativeEntry` 的入参相应加 `batchId?: string`。

---

## 运行时接入 · messages 组装流程

### 关键架构原则：coreLoop 只调 assembleContext

**coreLoop 不直接调 messages-builder 和 NarrativeHistoryReader**。这两者是
memory adapter 的内部工具。coreLoop 仍然通过 `assembleContext` 作为 **唯一组装入口**
拿到（systemPrompt + messages）。

为什么这样设计：

- `assembleContext` 职责不变：把 state / rules / engine memory / scene context / messages
  通道等"上下文全家桶"组合成一套喂给 streamText 的东西
- memory adapter 是插拔点：legacy / mem0 / LLMSummarizer 各自决定怎么把 narrative_entries
  变成"engine memory"（摘要 + 最近 messages 历史）。不同策略在 adapter 内部做，外层不关心
- `messages-builder` 和 `NarrativeHistoryReader` 是给 **memory adapter 内部**用的工具
- coreLoop 只管循环 + tool 副作用 + 等输入，和"怎么拼 LLM context"解耦

### 层次图

```
narrative_entries (DB, canonical)
    │
    │ NarrativeHistoryReader
    │
    ▼
Memory Adapter  (legacy / mem0 / LLMSummarizer)
  内部用 messages-builder 把最近 entries 转 ModelMessage[]，
  自己决定"最近 N 条结构化 messages + 更早走摘要 / 检索"的分层策略
    │
    │ memory.getRecentAsMessages() / memory.retrieve()
    │
    ▼
assembleContext  (唯一组装入口)
  systemPrompt sections: state / rules / engine_memory / scene_context ...
  messages[] 通道: 来自 memory.getRecentAsMessages()
    │
    ▼
coreLoop → streamText
```

### 方案 B 的 coreLoop 伪代码

```ts
// game-session.ts 方案 B 的 coreLoop（伪代码）
while (this.active) {
  turn++;

  // 1. 统一通过 assembleContext 组装 context —— 它内部向 memory adapter 要
  //    engine memory（summary + 最近 messages 历史）
  const { systemPrompt, messages } = await assembleContext({
    memory: this.memory,
    state: this.stateStore.getAll(),
    segments: this.segments,
    budget: this.tokenBudget,
    ...
  });

  // 2. 调 streamText
  const result = await this.llmClient.generate({
    systemPrompt,
    messages,
    tools,
    stopWhen: [stepCountIs(20), hasToolCall('signal_input_needed'), hasToolCall('end_scenario')],
  });

  // 3. generate() 返回后，判断有没有 pendingSignal
  if (this.pendingSignal) {
    emitter.setInputType(this.pendingSignal.choices?.length ? 'choice' : 'freetext',
                         this.pendingSignal.choices);
    emitter.setInputHint(this.pendingSignal.hint);
  } else if (this.scenarioEnded) {
    break;
  } else {
    // maxSteps 击中或 LLM 自然停止 —— UX 提示继续
    emitter.setInputHint('请继续推进剧情');
    emitter.setInputType('freetext');
  }

  // 4. 等玩家输入
  const inputText = await this.waitForInput();
  if (!this.active) break;

  // 5. 写 player_input entry，进入下一轮
  await this.persistence?.onReceiveComplete({ ... });
  this.pendingSignal = null;
}
```

### memory adapter 内部怎么用 messages-builder（未来实施）

以 legacy adapter 为例（**这是后续 memory refactor 的事，不在 PR-M1 范围**，只示意）：

```ts
// 未来的 legacy adapter
class LegacyMemory implements Memory {
  constructor(
    private scope: MemoryScope,
    private reader: NarrativeHistoryReader,  // 注入
  ) {}

  async getRecentAsMessages({ budget }): Promise<RecentMessagesResult> {
    // 1. 从 reader 拉最近 N 条 entries
    const recent = await this.reader.readRecent({ limit: RECENT_CAP });
    // 2. 用 messages-builder 转结构化 messages
    const messages = buildMessagesFromEntries(recent);
    // 3. 按 budget 裁剪
    return clipByBudget(messages, budget);
  }

  async retrieve(query): Promise<MemoryRetrieval> {
    // legacy 的关键词匹配 —— 从 reader 拉 entries 做匹配
    // 或从 snapshot 里的摘要 / pinned 合成 summary
    ...
  }
}
```

mem0 / LLMSummarizer 同样注入 reader，各自策略。

**PR-M1 的范围**里 memory adapter 暂不做这个切换（继续用 snapshot.entries 副本），
messages-builder 先作为独立纯函数 + 单元测试存在。PR-M2（方案 B）切换 coreLoop 时也不
强制 memory adapter 切 —— 方案 B 只要 coreLoop 的循环结构变，memory 继续用它那套副本也
能跑。真正让 memory 用上 reader + builder 是再下一波 refactor。

### NarrativeHistoryReader 接口

```ts
// src/core/memory/narrative-reader.ts（新）

export interface NarrativeHistoryReader {
  /** 读最近 N 条 entries（orderIdx 升序） */
  readRecent(opts: { limit: number; kinds?: EntryKind[] }): Promise<NarrativeEntry[]>;

  /** 按 orderIdx 范围读 */
  readRange(opts: { fromOrderIdx?: number; toOrderIdx?: number }): Promise<NarrativeEntry[]>;

  // 未来：readPinned()、readByBatchId(batchId) 等
}
```

Server 端实现（`server/src/services/narrative-reader.ts`）：

```ts
export function createNarrativeHistoryReader(playthroughId: string): NarrativeHistoryReader {
  return {
    async readRecent({ limit, kinds }) {
      const all = await playthroughService.loadEntries(playthroughId, limit, 0);
      return kinds ? all.filter(e => kinds.includes(e.kind as EntryKind)) : all;
    },
    async readRange({ fromOrderIdx, toOrderIdx }) {
      // 新 service 方法；drizzle where 按 order_idx between
      return playthroughService.loadEntriesInRange(playthroughId, fromOrderIdx, toOrderIdx);
    },
  };
}
```

**注**：这个接口定位为 **memory adapter 的内部依赖**，不是 coreLoop 的直接依赖。
PR-M1 里先定义接口 + server 端实现；coreLoop 和挂起模式都暂时不用它（memory adapter
继续用 snapshot 副本）。未来 memory refactor 时注入给各 adapter，它们内部用 reader 拉
entries + 用 messages-builder 转结构化 messages。

messages-builder 的直接消费者路径（长远）：

```
Memory Adapter.getRecentAsMessages()
    → this.reader.readRecent()      // 拉 entries
    → buildMessagesFromEntries()    // 转 ModelMessage[]
    → 按 budget 裁剪返回
```

messages-builder 不作为 coreLoop 的 import 对象。

---

## 落地拆分

### PR-M1 Messages Model（独立可 merge，挂起模式不变）

范围：
1. migration 0011 加 `batch_id` 列 + index
2. schema.ts / NarrativeEntryRow / appendNarrativeEntry 接受 `batchId`
3. `src/core/persistence-entry.ts` 新增 TS 类型 + 守卫
4. `src/core/messages-builder.ts` 新增纯函数 + 单元测试
5. `src/core/memory/narrative-reader.ts` 新增接口
6. `server/src/services/narrative-reader.ts` 新增实现
7. `server/src/services/playthrough-service.ts` 加 `loadEntriesInRange` 方法
8. `SessionPersistence` 各方法接受可选 `batchId`
9. `llm-client.ts` experimental_onStepStart/onToolCallFinish/onStepFinish 埋 batchId + 调
   onToolCallRecorded
10. `playthrough-persistence.ts` 实现 onToolCallRecorded、其他回调透传 batchId
11. `game-session.ts` 各 onXxxRecorded 调用处挂 batchId（从 llm-client 的 step start 钩子里拿）

**不改**：coreLoop 结构、挂起模式、signal_input_needed.execute 行为。

**效果**：
- tool_call entry 开始入库（update_state / change_scene / query_memory 等每次调用一条）
- 所有 entries 开始带 batchId
- messages-builder + NarrativeHistoryReader 作为独立工具存在，**不挂进任何 memory
  adapter，也不从 coreLoop 调**，只在 unit test 里被验证
- memory adapter 内部继续用 snapshot.entries 副本 + 自己的 getRecentAsMessages 路径
  （和挂起模式一致）。真正接入由后续 memory refactor 做

**非目标（明确推迟）**：
- memory adapter 内部切换到 reader + messages-builder
- 替换 `memory.getRecentAsMessages()` 的具体实现
- coreLoop 走新 messages 路径

### PR-M2 方案 B 切换（本 PR 落地之后，独立计划）

见 `turn-bounded-generate.md`，在 PR-M1 基础上：
- tool-executor signal_input_needed record-only
- llm-client stopWhen hasToolCall
- game-session coreLoop 重写成 turn-bounded（仍然走 `assembleContext`，不直接调
  messages-builder）
- 删挂起相关代码

PR-M2 **不强制** memory adapter 内部切换到 reader + messages-builder，挂起模式和
方案 B 都可以在旧 adapter 实现上跑。"memory adapter 降级为 cache" 作为独立 Memory
Refactor v2 后续执行。

---

## PR-M1 文件清单

### 新增

```
server/drizzle/0011_messages_model.sql
server/drizzle/meta/_journal.json            (追加 0011)
src/core/persistence-entry.ts                TS 类型 + 守卫
src/core/messages-builder.ts                 纯函数（~200 行）
src/core/memory/narrative-reader.ts          接口定义
server/src/services/narrative-reader.ts      server 端实现
src/core/__tests__/messages-builder.test.ts  单测（~15 用例）
src/core/__tests__/persistence-entry.test.ts 类型守卫单测（~5 用例）
```

### 修改

```
server/src/db/schema.ts
  narrativeEntries 加 batchId 列
  导出 EntryKind 类型等别名

server/src/services/playthrough-service.ts
  NarrativeEntryRow 加 batchId 字段
  appendNarrativeEntry 接受 batchId
  新增 loadEntriesInRange(playthroughId, fromOrderIdx, toOrderIdx)

server/src/services/playthrough-persistence.ts
  onNarrativeSegmentFinalized / onSignalInputRecorded / onReceiveComplete 透传 batchId
  新增 onToolCallRecorded 实现（kind='tool_call', content=toolName, payload={input, output}）

src/core/game-session.ts
  SessionPersistence 接口加 batchId 字段 + onToolCallRecorded
  createWaitForPlayerInput 里的 onSignalInputRecorded 调用挂 batchId
  submitInput 里 onReceiveComplete 调用挂 playerBatchId
  onNarrativeSegmentFinalized 调用挂 currentBatchId

src/core/llm-client.ts
  experimental_onStepStart 生成 batchId 并暴露给外层（通过 stepSystemMap 类似机制）
  experimental_onToolCallFinish 调 persistence.onToolCallRecorded（signal_input_needed 跳过）
  StepInfo 加 batchId 字段供 tracing 使用

server/src/__tests__/playthrough-service.test.ts
  新增 batchId 存取测试
  新增 loadEntriesInRange 测试
  新增 tool_call kind 存储测试

server/src/__tests__/playthrough-persistence.test.ts
  onToolCallRecorded 测试（3-4 用例）
  其他 on* 回调的 batchId 透传测试
```

---

## PR-M1 测试清单

### `messages-builder.test.ts`（~15 用例）

1. **empty**: 空 entries → `[]`
2. **only narrative**: 单条 narrative batch → 单 assistant text
3. **multi narrative same batch**: 多条 narrative 同 batchId → 单 assistant，text 合并
4. **narrative + signal_input same batch**: → assistant [text, tool-call(signal_input_needed)] + tool
5. **narrative + tool_call same batch**: → assistant [text, tool-call(update_state)] + tool 含 tool-result
6. **narrative + multiple tool_calls + signal_input same batch**: → assistant 含全部 tool-call，tool 含全部 tool-result
7. **signal_input without narrative**: → assistant 仅含 tool-call block（无 text）
8. **tool_call only, no narrative, no signal**: → assistant 仅 tool-call + tool
9. **full cycle**: LLM step + player input + LLM step → 3 messages 顺序正确
10. **multiple player_inputs**: 连续两个 player_input（未来多模态预留）→ 两个 user messages
11. **batchId=null fallback**: 老数据无 batchId，按 player_input 分 turn 启发式组
12. **mixed batchId null 和非 null**: 老数据 + 新数据混合
13. **narrative content 保留原 XML-lite 不 normalize**: `<d s="alice">` 原样出现在 text block
14. **toolCallId 稳定**: 使用 entry.id 作为 toolCallId，assistant 的 tool-call 和 tool 的 tool-result 配对正确
15. **orderIdx 乱序输入**: 输入 entries orderIdx 不升序时 builder 先排序再组装（或抛错）

### `persistence-entry.test.ts`（~5 用例）

1. isSignalInputEntry 守卫正确
2. isToolCallEntry 守卫正确
3. isPlayerInputEntry 守卫正确
4. isNarrativeEntry 守卫正确
5. 非法 kind 的 entry 守卫全部返回 false

### `playthrough-service.test.ts` 新增（3-4 用例）

1. appendNarrativeEntry 带 batchId 落库 + readback
2. appendNarrativeEntry 不传 batchId → null
3. loadEntriesInRange 正确过滤
4. tool_call kind 存取（content=toolName, payload={input, output}）

### `playthrough-persistence.test.ts` 新增（3-4 用例）

1. onToolCallRecorded 写入 kind='tool_call' + payload
2. onToolCallRecorded 尊重 batchId
3. onSignalInputRecorded 透传 batchId
4. 多次 onXxxRecorded 按 orderIdx 单调递增

---

## 风险与兜底

### R1: experimental_ hooks 的稳定性

AI SDK v6 的 `experimental_onStepStart` / `experimental_onToolCallFinish` 是 `experimental_`
前缀，API 可能变动。

**兜底**：
- 实际测试当前版本（6.0.168）行为
- 如果将来升级 ai 包 API 变了，wrapper 做成"做法 A"的版本作为后备（在 tool-executor 里包装每个 execute）

### R2: batchId 没在 step 内清零导致的跨 step 串台

如果 `experimental_onStepFinish` 没被及时调用（比如 stream 异常中断），currentBatchId 可能
污染下一次 generate()。

**兜底**：
- 在 generate() 的 finally 块里主动清零 currentBatchId
- 单元测试覆盖异常中断路径

### R3: messages-builder 和 Anthropic/OpenAI 实际期待格式不匹配

不同 provider 对 tool-use/tool-result 的 content block 格式有细微差异（AI SDK v6 应该已经
帮我们抹平，但可能有 edge case）。

**兜底**：
- PR-M1 merge 后，用 playtest 剧本跑一局挂起模式，把 buildMessagesFromEntries 的输出和
  AI SDK 自己的 response.messages 对比（手动 diff），确保等价
- 这一步放在 PR-M2（方案 B 切换）前作为验证关口，**不是 PR-M1 的 blocking 要求**
  （M1 不切换只 unit test）

### R4: LLMSummarizer / mem0 adapter 的 getRecentAsMessages 依旧用旧路径

PR-M1 不改 memory adapter，它们仍然基于 snapshot.entries 副本。挂起模式下 coreLoop 继续
从 `assembleContext` → `memory.getRecentAsMessages` 拿历史 —— 和 PR-M1 的 messages-builder
**并行存在但不相互替代**。

**说明**：这是刻意的分阶段切换。PR-M1 只落工具；后续 memory refactor 让各 adapter 在内部
用 reader + messages-builder 替换掉 snapshot.entries 副本路径；方案 B 的 coreLoop 重写
期间也不强依赖这个切换。

### R5: tool_call entries 把历史变大

每局 LLM 调 tools 多（update_state / change_scene / pin_memory / query_memory 轮番），加上
backfill 这些进 entries，DB 写压力和后续 load 时间可能增加。

估算：平均一局 20 回合 × 每回合 5 tool calls = 100 条 tool_call entries。加上 narrative /
signal / player 另外约 80 条。一局 200 条左右，每条 < 1KB，整体 < 200KB 可接受。

**兜底**：
- PR-M1 后观察生产 DB 单局 entries 数量，若超预期加 index 或归档策略
- 未来可加"近 N 条完整 + 更早摘要"的分层加载

---

## 验收标准

PR-M1 完成标准：
- [ ] `bun tsc --noEmit` 前端绿
- [ ] `cd server && bun tsc --noEmit` 后端绿
- [ ] `cd server && bun --env-file=.env.test test` 全过（现有 101 + 新增 ~15 = ~116 tests）
- [ ] `bun test src/core src/stores` 全过（现有 67 + 新增 ~20 = ~87 tests）
- [ ] staging 启动 server（runMigrations 自动跑 0011），跑一局挂起模式 playtest 确认：
  - narrative_entries 里 tool_call kind 行开始出现
  - batch_id 列在新行里有值
  - 挂起模式 UI 行为完全不变（backlog / 游戏流）

PR-M1 非目标（推迟）：
- memory adapter 切换到 narrative-reader
- coreLoop 改用 messages-builder
- 方案 B 的 signal_input_needed record-only 改造

---

## 与 `conversation-persistence.md` 的关系

那份文档 Step 1-4 完成了 signal_input / player_input / kind 基础结构。本文档在其上：
- 加 tool_call kind（扩全 4 种）
- 加 batchId 列
- 把"视图层重建"的纯函数（messages-builder）和 reader 接口形式化
- 为方案 B 铺完整路径

Step 1-4 的 migration 0010 已经给 narrative_entries 加了 kind/payload 两列，0011 只再加
一个 batch_id 列，增量很小。
