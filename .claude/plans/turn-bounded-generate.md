# 方案 B · 每玩家回合 = 一次 generate()

> Status: **设计讨论中**
> 触发问题: maxSteps 30 击中 + 静默卡死（trace 64b36083）
> 相关现状分析: 当前 `signal_input_needed` 用挂起（suspend）机制把一次
>   `generate()` 的生命周期延展到**整个 session**。maxSteps 不是"每轮预算"
>   而是"整局预算"。

---

## 现状 · "一次 generate = 整局"

```
玩家连接 WS
    │
    ▼
coreLoop 外循环 while (this.active)：  ← 只会迭代一次（或少数几次）
  turn++
  assembleContext()
  generate() ─────────────────────────┐
    │ step 0: tool_call read_state    │
    │ step 1: tool_call change_scene  │
    │ step 2: narrative + signal_input_needed
    │         ↓ 挂起，等玩家输入      │ ← 这里不返回，在 event loop 里等
    │ 玩家点击 → tool resolve         │
    │ step 3: narrative + signal_input_needed
    │         ↓ 挂起再等              │
    │ ... 重复 N 次 ...               │
    │ step 29: tool_call update_state │
    │ stopWhen: stepCountIs(30) 触发  │ ← 被强制返回
    └─────────────────────────────────┘
  Receive Phase 外循环兜底（无 hint/无 choice）
    waitForInput()...
```

问题：
- `maxSteps` 是"整局"预算，30 步 ≈ 10 个玩家回合就封顶
- 击中后 UI 静默卡死（外循环 Receive Phase 不带 hint/choices）
- 每 generate() 一条 Langfuse trace → 单条 trace 囊括整局，调试困难
- Focus Injection 需要 prepareStep 魔法在 generate 内部重 assemble
- 章节切换等"state 驱动的 prompt 重组"都塞进 prepareStep，复杂度累积

---

## 方案 B · 每回合独立 generate()

核心想法：**让 `signal_input_needed` 不再挂起，而是作为 `stopWhen` 停止
条件让 generate() 干净返回**。Receive Phase 变成主干机制。

### 核心循环

```
玩家连接 WS
    │
    ▼
coreLoop 外循环 while (this.active)：  ← 每个玩家回合迭代一次
  turn++

  ┌─ Phase 1 · 生成回合内容 ─────────────────────────┐
  │ assembleContext()                                │
  │   （按最新 state.chapter / current_scene 装段）  │
  │                                                  │
  │ llm.generate({                                   │
  │   tools: { signal_input_needed, end_scenario,    │
  │            change_scene, update_state, ... },    │
  │   stopWhen: [                                    │
  │     stepCountIs(30),                             │
  │     hasToolCall('signal_input_needed'),  ← 调即停│
  │     hasToolCall('end_scenario'),          ← 同  │
  │   ],                                             │
  │ })                                               │
  │                                                  │
  │ (signal_input_needed.execute 不挂起，只把 hint/  │
  │  choices 记到 this.pendingSignal；返回给 LLM     │
  │  success:true，LLM 下一 step 开始前 stopWhen 触发│
  │  → generate() 返回)                             │
  └─────────────────────────────────────────────────┘
  flushPendingNarration()
  narrativeParser.finalize()
  persistence.onGenerateComplete({ memorySnapshot, currentScene, ... })

  if (this.scenarioEnded) break

  ┌─ Phase 2 · 等玩家输入 ─────────────────────────┐
  │ if (this.pendingSignal) {                       │
  │   emitter.setInputHint(this.pendingSignal.hint) │
  │   emitter.setInputType('choice' / 'freetext',   │
  │                         choices)                 │
  │ } else {                                         │
  │   // maxSteps 击中 或 LLM 自然 stop              │
  │   emitter.setInputHint('请继续输入推进剧情')     │
  │   emitter.setInputType('freetext')              │
  │ }                                                │
  │ emitter.setStatus('waiting-input')               │
  │ persistence.onWaitingInput({ hint, choices, ... })│
  │                                                  │
  │ const inputText = await this.waitForInput()     │  ← 外循环挂起
  │                                                  │
  │ if (!this.active) break  // stop() 被调用        │
  │                                                  │
  │ emitter.appendEntry({ role: 'receive', ... })   │
  │ emitPlayerInputSentence(inputText)              │
  │ memory.appendTurn({ role: 'receive', ... })     │
  │ persistence.onReceiveComplete({...})            │
  │ this.pendingSignal = null                       │
  └─────────────────────────────────────────────────┘

  continue  // 下一个玩家回合
```

### `signal_input_needed` 工具改造

```ts
// src/core/tool-executor.ts

tools['signal_input_needed'] = handler(
  'signal_input_needed',
  z.object({
    prompt_hint: z.string(),
    choices: z.array(z.string()),
  }),
  (args) => {
    const { prompt_hint, choices } = args as { prompt_hint: string; choices: string[] };
    // 不再挂起。只把 hint/choices 记到会话上下文，让 coreLoop 在 generate 返回后读。
    ctx.recordPendingSignal?.({ hint: prompt_hint, choices });
    return { success: true };
  },
);
```

`ToolContext` 新增 `recordPendingSignal`。`GameSession` 在每次 generate() 调用前
清空 `this.pendingSignal`，generate() 结束后读。

### 工具调用链路

| Tool | 现在 | 方案 B |
|---|---|---|
| `read_state` | 同步读 state，返回 | 同 |
| `update_state` | 同步改 state，返回 | 同 |
| `change_scene` | 记录 scene，emit 事件 | 同 |
| `pin_memory` / `query_memory` | 同步 | 同 |
| **`signal_input_needed`** | **挂起 Promise** 等玩家输入 | **记录 pending，返回成功**。stopWhen 拦截下一 step |
| `end_scenario` | 记 flag，LLM 继续输出尾声 | 同（stopWhen 拦截下一 step 而不是 natural stop） |

### 可删除 / 简化的代码

| 当前代码 | 方案 B 后 |
|---|---|
| `GameSession.createWaitForPlayerInput()` | **删除** —— 不再需要 |
| `GameSession.signalInputResolve` 字段 | **删除** |
| `submitInput` 里 `if (this.signalInputResolve)` 分支 | **删除**；只走 `inputResolve`（外循环 receive） |
| `waitForInput()` | 保持（唯一的等玩家机制） |
| Focus Injection D 的 prepareStep | **简化** —— 还需要但只在回合内覆盖 within-turn 的 scene 切换；回合间（章节切换）由下一次 assembleContext 自然处理 |

---

## 关键改动文件清单

| 文件 | 改动 |
|---|---|
| `src/core/tool-executor.ts` | `signal_input_needed` 改成 record-only |
| `src/core/llm-client.ts` | 暴露 `stopWhen` 扩展参数；支持 `hasToolCall(name)` |
| `src/core/game-session.ts` | coreLoop 重写成 turn-bounded；删 `createWaitForPlayerInput`；pendingSignal 字段 |
| `server/src/services/playthrough-persistence.ts` | `onWaitingInput` 的场景覆盖 |
| 测试 | coreLoop 新行为的 e2e；signal_input_needed 不再挂起的单测 |

---

## 对比收益

| 维度 | 当前（A 维持 30/60 + 加 UX） | 方案 B |
|---|---|---|
| maxSteps 语义 | 整局预算 | 每回合预算（30 很宽松） |
| Trace 粒度 | 一局一 trace | 一回合一 trace（查 bug 天堂） |
| 成本可控性 | 一局跑飞成本巨大 | 每回合独立，最坏浪费一回合 |
| 章节切换 | 需要 prepareStep 魔法 | 回合间 assembleContext 自然刷新 |
| 代码复杂度 | signal 挂起 + 外循环 receive 两套机制 | 只有外循环 receive |
| 重连恢复 | 需要处理"generate 挂起中"的中间态 | 只有 "waiting-input" 状态 |
| Focus Injection D | 必不可少 | within-turn 仍需，across-turn 可不用 |
| **玩家体验** | 每 10 回合可能卡一次 | 无卡顿 |

---

## 潜在的坑

### 1. LLM 调 signal_input_needed 之后继续输出

`stopWhen: hasToolCall('signal_input_needed')` 的语义是"**下一次 step 发起前**
检查，命中则停"。也就是说 LLM 在同一步里调完 signal 后**可能还在同一步
里继续输出**（text + 其它 tool）。AI SDK 设计下，同一个 step 的内容一次性
返回给我们；只是不开新 step。

需要测：
- signal 作为本 step 的**最后一个** tool call → 理想
- signal 之后 LLM 又调了 end_scenario → 同一步里两个 stopWhen 条件都触发，没冲突
- signal 之后 LLM 又调了 update_state → update_state 执行，同 step 内 narrative 也输出；下一 step 不开

### 2. `end_scenario` 之后 LLM 的"收尾段"

当前设计：`end_scenario` 只记 flag，LLM 在同一步内可以继续输出几句收尾
narrative。这个行为方案 B 下保留 —— 还是 stopWhen 下一步前拦截。

### 3. 重连 restore 时的语义

重连时 playthrough 处于 `waiting-input` 状态，DB 里有 `inputHint / choices`。
restore() 后直接进入 Phase 2（外循环 waitForInput），不进 generate()。

玩家给输入 → 按常规 coreLoop 继续下一回合 generate()。自然。

### 4. messages 历史重建

每回合新一次 generate()，messages 需要包含：
- system prompt（assembleContext 构建）
- 所有历史 turn 的 user/assistant 消息对
  - 由 `memory.getRecentAsMessages({budget})` 返回（已实现）
- 本回合玩家输入（由外循环末尾 `memory.appendTurn({role:'receive'})` 压入）

已经有的机制，方案 B 直接复用。

### 5. Focus Injection D 的定位

within-turn 仍需 —— 玩家一个选择可能触发 LLM 在一回合内改 scene 多次（老剧本里很少，但有可能）。prepareStep 保留以覆盖这种情况。

但**回合间**的大多数 prompt 重组（scene 切换 / chapter 切换 / 新 state 进来）
由下一次 assembleContext 自然处理，**不依赖 prepareStep**。

### 6. Langfuse trace 数量增长

从"一局一 trace"变成"一回合一 trace"，数据量 × 10 左右。Langfuse/ClickHouse
存储成本会涨。可接受（OSS 很便宜）。

观测性换档：
- 现在：一条 trace 能看全局；找具体一回合的事情要搜
- 之后：每回合一 trace，trace 列表按 sessionId 过滤就能拉到整局时间线

---

## 未决问题

1. **stopWhen 里的 `hasToolCall('signal_input_needed')` AI SDK v6 是否支持**  
   需要查 `node_modules/ai/dist/index.d.ts` 确认。如果没有，可以用自定义 condition：
   ```ts
   stopWhen: [
     stepCountIs(30),
     ({ steps }) => steps.some(s => s.toolCalls.some(tc => tc.toolName === 'signal_input_needed')),
     ({ steps }) => steps.some(s => s.toolCalls.some(tc => tc.toolName === 'end_scenario')),
   ]
   ```

2. **maxSteps 调整到多少**  
   每回合典型 3-5 步。放 30 是 10 倍余量。失控回合的 cap。保持 30 或调到 40 都行。

3. **Langfuse trace 名字 / session 关联**  
   现在 `game-generate` 一次 trace。方案 B 变成每 turn 一次：
   - name 继续 `game-generate`
   - sessionId 用 playthroughId（不变）—— 一个 session 能拉到所有 turn 的 trace 列表

4. **需不需要"本回合"的概念专门持久化**  
   当前 turn 号已经在 playthrough 表里。回合边界清晰后可以：
   - `narrative_entries` 加 `turn` 列（现在已经有 `orderIdx`，但 turn 更语义）
   - Langfuse trace metadata 里打 `turn` 便于过滤

---

## 实施顺序（如果动手）

1. 确认 AI SDK v6 的 `hasToolCall` 或等价 stop condition
2. tool-executor.ts signal_input_needed record-only 改造（加 ctx.recordPendingSignal）
3. game-session.ts coreLoop 重写 + 删除 suspend 机制
4. 更新 tests：新 coreLoop 的 e2e / signal 不挂起的 unit test
5. staging E2E 验证 b2-demo 和 anjie 两个剧本
6. 观察 trace 数量 / 成本变化

估计代码改动 200-400 行（主要是 coreLoop 重写 + 删除 suspend 分支的连带更新）。
测试改动类似规模。

---

## 不做方案 B 的情况

保持当前架构 + 做方案 C（UX 兜底）的时候，可以一直不动到：
- 玩家反馈 maxSteps 击中频繁影响体验
- 调试 bug 时被单条 trace 困扰
- 要做长篇剧本（单局超过 20 回合）

如果以上不出现，方案 B 可以长期搁置。真出现时再实施，代价固定，不随时间增长。
