# 架构对齐 —— 理想图 vs 现实实现

> Status: **参考图固化**（2026-04-23）
> 基于用户手绘核心循环图 + 代码现状对比
> 相关文档: `messages-model.md`, `turn-bounded-generate.md`, `memory-refactor.md`

---

## 理想架构（canonical 参考图）

每玩家回合 = 一个循环：

```
┌─ 输入 ────────────────┐
│  Script Asset         │
│  Player Input         │──→ Assembler ──→ LLM narrator
│  Relevance Memory     │                       │
└───────────────────────┘                       ↓
                                        Narrative Entry
                                               │
                                               ↓
        ┌──── Memory System ←──── History ──────┬──→ UI
        │                          (append)     │
        ↓                                       │
  Relevance Memory ───(下一轮召回)───→ 回到顶部
```

### 图的特性

1. **三路输入汇聚 Assembler**：Script Asset、Player Input、Relevance Memory 三股平行输入
2. **LLM 产出 Narrative Entry 一个事件**
3. **History 是 append-only 单一真相**（canonical source）
4. **History 双 fanout**：UI（当前展示）+ Memory System（后续索引 / 压缩）
5. **Memory System 的产物是 Relevance Memory**，作为下一轮的检索输入
6. **没有双写 / 没有副本**：History 是唯一"对话真相"

---

## 组件映射表

| 图里 | 我们代码 | 关键文件 |
|---|---|---|
| **Script Asset** | PromptSegment[] + StateStore + initialPrompt + manifest | `src/core/context-assembler.ts`, `src/core/state-store.ts` |
| **Player Input** | `lastPlayerInput` + player_input 类 entry | `src/core/game-session.ts` |
| **Relevance Memory** | `memory.retrieve(query).summary` + `memory.getRecentAsMessages()` | `src/core/memory/*` |
| **Assembler** | `assembleContext()` | `src/core/context-assembler.ts` |
| **LLM narrator** | `LLMClient.generate()` → `streamText` | `src/core/llm-client.ts` |
| **Narrative Entry** | narrative_entries 行（kind = narrative \| signal_input \| tool_call \| player_input） | PG table + `persistence-entry.ts` |
| **History** | narrative_entries 表 + UI `parsedSentences` 数组 | DB + `game-store.ts` |
| **UI** | VNStage / DialogBox / Backlog / SpriteLayer / SceneBackground | `src/ui/play/vn/*` |
| **Memory System** | memory adapter（legacy / mem0 / LLMSummarizer）的 `appendTurn` + `maybeCompact` | `src/core/memory/legacy/`, `mem0/`, `llm-summarizer/` |

### 图里没显示但我们有的组件

- **State Store**（状态变量 KV 存储）：LLM 通过 `update_state` tool 改 → 下轮 assembleContext 读
- **Scene State**（VN 视觉层快照）：LLM 通过 `change_scene` / `change_sprite` / `clear_stage` tool 改 → WS 推流 → VN 立绘 / 背景
- **Tools**（LLM agentic 能力）：除了 signal_input_needed / end_scenario，还有 update_state / change_scene / pin_memory / query_memory 等

扩展后的架构全图：

```
                    ┌─ Tools (update_state / change_scene / signal_input_needed / ...)
                    │    │ 副作用：改 State Store / Scene State / Memory 等
                    │    │
State Store ───────→│
Script Asset ──────→ Assembler ←─── Relevance Memory
Player Input ──────→│
                    ↓
                LLM narrator
                    ↓
            [narrative | tool_call | signal_input | player_input] entry
                    ↓
             narrative_entries (History, canonical)
                    ├─→ UI (WS sentence stream + restore replay)
                    └─→ Memory System ─→ Relevance Memory
                                                │
                                                └─(下一轮 retrieve)
```

---

## 现实偏离点

### 核心偏离：双写

**图**：
```
LLM → Narrative Entry → History ─┬→ UI
                                  └→ Memory System
```

**现实**：
```
LLM 输出流
  ├─ NarrativeParser → Sentence → emitter.appendSentence → WS → UI
  ├─ currentNarrativeBuffer（攒原文）
  │    ├─ onNarrativeSegmentFinalized → narrative_entries 表 ─→ restore / backlog UI
  │    └─ memory.appendTurn(content) ─→ memory adapter 内部又存了一份 entries 副本
  │                                       └─ memory.retrieve() 从副本检索
```

**症状**：代码里有长长的双写同步注释：

```ts
// 为什么两个都要：
//   - onNarrativeSegmentFinalized 只写 narrative_entries，不写 memory_entries
//   - memory.appendTurn 只改内存，不写 DB
//   - generate() 返回后的 memory.appendTurn(result.text) 会包含 ALL text，
//     但在 signal 挂起期间 generate() 还没返回，memory 里看不到本段叙事。
//     如果此时断线重连，memory 就是空的 → LLM 没有 recent history。
```

这段注释的存在本身就是偏离的证据 —— 如果 Memory System 只从 History 读，就不会有"两套副本要手动同步"的问题。

### 已修过的 bug（历史）

- `commit bb3c6f4 fix(memory): signal 挂起前写 memory + 持久化 memoryEntries —— 修复 history 丢失`
- `commit 74ba0c3 fix(memory): Mem0 flush 改为 appendTurn 里 fire-and-forget（绕过 generate 挂起）`

都是双写不一致导致的生产问题。

---

## 偏离的历史成因

### 第一阶段：只有 MemoryManager

项目最早期只有一个 `MemoryManager`，**身兼两职**：
- 存对话历史的原件（state.entries）
- 做压缩 / 摘要 / 关键词检索

没有独立的 narrative_entries 表，所有对话真相都在 MemoryManager 里。

### 第二阶段：v2.5 加持久化

引入 PostgreSQL + narrative_entries 表。但**没借机合并**，为求快速上线保留了两份真相：
- narrative_entries（新）
- playthroughs.memory_entries / memory_summaries（老，MemoryManager 的 snapshot）

DBA 视角这是典型的"双写不一致"反模式。

### 第三阶段：memory-refactor 重构

抽 Memory 接口 + 加 mem0 / LLMSummarizer adapter 时，非目标里明确写着"不动 narrative_entries"：

```markdown
（来自 .claude/plans/memory-refactor.md）
非目标：
  - 不动 `messages[]` 通道的位置
  - 不改 `context-assembler.ts` 的 section 组装顺序
```

所以这次重构只抽了接口，没动"memory 存 entries 原件"这件事。

### 第四阶段：migration 0009 合并字段

把 `memory_entries` + `memory_summaries` 合并成 `memory_snapshot` 单列 jsonb。legacy 的 snapshot 内部**仍然包含完整 entries**，只是换了容器。mem0 不需要（云端托管），但 legacy 需要。

---

## PR-M1 铺的收敛路径

PR-M1（2026-04-23）已经建好了所需的基础设施：

| PR-M1 产物 | 对应图里的作用 |
|---|---|
| `narrative_entries.batch_id` + 4 种 kind | History 结构化到"一条 entry = 一次事件" |
| `NarrativeHistoryReader` 接口 | History → Memory System 的**规范读口** |
| `messages-builder` 纯函数 | Memory System → Assembler 的**组装工具** |
| `persistence-entry.ts` TS 类型 + 守卫 | 给未来 adapter 消费 entries 用 |

这些工具**还没被 memory adapter 使用** —— 它们是 PR-M1 留下来供 Memory Refactor v2 接入的抽象层。

---

## Memory Refactor v2 — 让现实完全对齐图

### 目标

让 memory adapter **不再持有 entries 副本**，通过 `NarrativeHistoryReader` 从 `narrative_entries` 读数据，自己只维护"派生视图"（摘要 / 向量索引 / pinned）。

完成后：
- `History → Memory System` 是实打实的唯一路径（对应图里的箭头）
- 删除 `memory.appendTurn` 的调用（game-session 不再双写）
- 删除 `MemorySnapshot` 里的 entries 字段（legacy / mem0 / llm-summarizer 各自 snapshot 瘦身）
- 代码里那段"为什么两个都要"的注释可以删除

### 详细计划

见 `.claude/plans/memory-refactor-v2.md`（进行中）。

---

## 对照图调整 / 补充建议

给手绘图加几个我们实际存在的组件：

```
                    ┌─ Tools 层（LLM agentic 能力）
                    │   · update_state → State Store
                    │   · change_scene / change_sprite → Scene State + UI
                    │   · signal_input_needed → pendingSignal → stopWhen 拦截 → 等 Player Input
                    │   · end_scenario → 终止 session
                    │   · pin_memory / query_memory → Memory System
                    │
State Store ──┐
Script Asset ─┼─→ Assembler ←─── Relevance Memory
Player Input ─┘      ↓
                LLM narrator ─── (调 Tools)
                     ↓
            [narrative | tool_call | signal_input | player_input] Narrative Entry
                     ↓
              narrative_entries (History, canonical, append-only)
                ├─→ UI (WS sentence stream + restore replay + backlog)
                └─→ Memory System (via NarrativeHistoryReader)
                              ↓
                    Relevance Memory (summary + retrieve)
                              └─(下一轮召回)──→ 回到 Assembler
```

### 独立的 Scene State 循环

```
LLM → change_scene tool → applyScenePatch → currentScene (playthroughs.current_scene)
                                                 ↓
                                              WS push
                                                 ↓
                                     VN UI (background / sprites)
                                                 ↓
                                      restore 时从 DB currentScene 恢复
```

### 独立的 State Store 循环

```
LLM → update_state tool → stateStore.update → playthroughs.state_vars
                                                    ↓
                                               下轮 assembleContext 读
                                                    ↓
                                          插进 prompt 的 state vars section
```

两个独立循环都走 Tools → 状态存储 → 下轮 Assembler / UI 消费，本质上是图里"Memory System → Relevance Memory → 下轮"的同构变体（只是持久化方式和消费点不同）。

---

## 验收标准

Memory Refactor v2 完成后应该能做到：
1. 删除 `game-session.ts` 里所有 `memory.appendTurn(...)` 调用
2. 删除"为什么两个都要"的长注释块
3. legacy adapter snapshot 的 entries 字段消失（或变成 empty placeholder 以兼容老数据）
4. `game-session.ts` 里的"确保 signal 挂起前先 memory.appendTurn 免断线丢失"逻辑不再需要（memory 不再自持有状态）
5. 代码审查能把 `narrative_entries → Memory System → Relevance Memory → Assembler` 的数据流一条线画出来

架构图 = 现实实现。
