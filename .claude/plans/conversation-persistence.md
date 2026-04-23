# 对话记录持久化重构 —— signal_input_needed 事件化

> Status: **实施中**
> 触发问题: 选项历史不可回看 / 回溯选别的选项没数据支撑 /
>   `narrative_entries.tool_calls` 列是 dead schema
> 相关文档:
>   - `.claude/plans/turn-bounded-generate.md`（方案 B —— 本重构的后继改造）

---

## 目标

两个正交价值：
1. **历史可见** —— 玩家在 backlog 能看到"第 N 步 GM 给了 [A/B/C]，我选了 B"
2. **回溯铺路** —— entries 结构化后，未来可以 fork playthrough 从某个 signal_input 重新选

本文档只做前 4 步（历史可见）。回溯（Step 5-6）另行处理。

---

## 现状问题

`signal_input_needed` 的一次完整往返（GM 问 → 玩家答）在持久化层面是**不完整**的：

| 信息 | 是否持久化 | 位置 |
|---|---|---|
| hint 文本 | 仅当前一刻 | `playthroughs.input_hint` 会被下一轮覆盖 |
| choices 数组 | 仅当前一刻 | `playthroughs.choices` 同上 |
| 玩家文本 | ✅ | `narrative_entries.content` (role='receive') |
| 玩家选了哪个 index | ❌ | 只能靠文本匹配推断，freetext vs. choice 不可辨 |
| 历史上的 hint/choices | ❌ | 完全丢失 |

额外：`narrative_entries.tool_calls` jsonb 列定义了，测试里写了，**生产代码从没往里写过**（`game-session.ts` 两个 appendNarrativeEntry 调用点 toolCalls 都是 undefined）。dead schema。

---

## 数据模型改造

### schema 加两列

```sql
ALTER TABLE narrative_entries
  ADD COLUMN kind text NOT NULL DEFAULT 'narrative',
  ADD COLUMN payload jsonb;

-- dead column 清理
ALTER TABLE narrative_entries DROP COLUMN tool_calls;
```

### kind 枚举

| kind | role | content 语义 | payload 结构 |
|---|---|---|---|
| `narrative` | generate | XML-lite 原文（现有行为） | null |
| `signal_input` | system | prompt_hint 文本 | `{choices: string[]}` |
| `player_input` | receive | 玩家输入文本 | `{selectedIndex?: number, inputType: 'choice' \| 'freetext'}` |

`signal_input` 为什么挂 role='system'：它不是 LLM 的 text 输出，也不是玩家的话，
是"运行时"加的事件。role='system' 目前代码里为 0 使用，正好拿来承担。

### 向后兼容

- 老 entries 的 `kind` 默认 'narrative'，行为不变
- `tool_calls` 列在任何生产环境都是 null（测试 fixture 除外），drop 安全
- `playthroughs.input_hint / choices` **保留**作为"当前状态快照"：
  - 写信号条目时同时更新快照（写一次）
  - 断线重连读快照 O(1)，不用回溯 entries 找最后一条 signal_input
  - 两套数据职责分清：快照 = 现在，entries = 历史

---

## 实施分 4 步（一个 PR 内可并，但分 commit 清晰）

### Step 1 · schema 迁移

- `server/drizzle/0010_signal_input_events.sql` —— 加 kind/payload + drop tool_calls
- `server/drizzle/meta/_journal.json` —— 登记 0010
- `server/src/db/schema.ts` —— narrativeEntries 字段同步 + 去掉 toolCalls
- `server/src/services/playthrough-service.ts`：
  - `appendNarrativeEntry` 入参 `{kind?, payload?}`（kind 默认 'narrative'）
  - 去掉 toolCalls 入参
- 测试：`playthrough-service.test.ts` / `playthrough-persistence.test.ts` 把 toolCalls 断言换成 kind/payload
- 验证：`cd server && bun test`

**commit**：`feat(persistence/a): narrative_entries 加 kind+payload，删 dead tool_calls`

### Step 2 · signal_input entry 写入

- `src/core/game-session.ts` 的 `SessionPersistence` 接口增 `onSignalInputRecorded(data: {hint, choices})`
- `server/src/services/playthrough-persistence.ts` 实现：调 `appendNarrativeEntry({kind:'signal_input', role:'system', content:hint, payload:{choices}})`
- `src/core/game-session.ts` 的 `createWaitForPlayerInput`：在 `onWaitingInput` 前调 `onSignalInputRecorded`（先写事件，再更新快照，顺序自然）
- 删 `SessionPersistence.onNarrativeSegmentFinalized` 的 `toolCalls` 字段
- 测试：新增"挂起前写一条 signal_input entry"
- 验证：`bun tsc --noEmit` + `cd server && bun test`

**commit**：`feat(persistence/b): signal_input_needed 调用时写 signal_input entry`

### Step 3 · player_input selectedIndex

- `src/core/game-session.ts`：
  - 在 `createWaitForPlayerInput` 里把 `options.choices` 缓存到 `this.pendingSignalChoices`
  - `submitInput(text)` 入口查 `pendingSignalChoices`：
    - 文本精确匹配某个 choice → `selectedIndex = i, inputType='choice'`
    - 不匹配 → `selectedIndex = undefined, inputType='freetext'`
  - 把 `{selectedIndex, inputType}` 传给 `onReceiveComplete`
- `SessionPersistence.onReceiveComplete` data 加 `payload: {selectedIndex?, inputType}`
- `playthrough-persistence.ts` 把 payload 透传给 `appendNarrativeEntry`
- 测试：玩家选 choices[1] → entry payload.selectedIndex === 1；自由输入 → selectedIndex undefined
- 验证：tsc + server tests

**commit**：`feat(persistence/c): player_input entry 记录 selectedIndex`

### Step 4 · UI 显示

- `src/core/types.ts` —— `Sentence` 加 `kind: 'signal_input'` 变体 `{hint, choices, ...}`
- `src/core/types.ts` —— 现有 `player_input` 变体加可选 `selectedIndex?: number`
- `src/stores/ws-client-emitter.ts` 'restored' handler：
  - role='system' && kind='signal_input' → 合成 signal_input Sentence
  - role='receive' → 读 payload.selectedIndex 挂到 player_input Sentence 上
- `src/ui/play/vn/Backlog.tsx` 渲染 signal_input：
  - 样式类似 narration 但带"📍"标记
  - 下面列 choices 数组
  - 紧跟的 player_input 如果 selectedIndex 有值，高亮对应选项
- `src/ui/play/vn/DialogBox.tsx`：当前 sentence 是 signal_input 时，用一个提示样式（不干扰正在等待输入的选项面板）
- `src/stores/game-store.ts` 的 `advanceSentence`：signal_input 自动跳过（和 scene_change 同级，不占 click）
- 验证：preview 看历史回放 + 新起局
- （LLM 相关改动不启动 preview，但这步是 UI 渲染，需要 preview E2E）

**commit**：`feat(persistence/d): backlog 显示历史 signal_input + 玩家选择`

---

## 架构与方案 B 的关系

方案 B（每回合 = 一次 generate）要求跨 generate 的 messages 重建，必须能从持久化层恢复"上回合 GM 问了什么 / 玩家答了什么"。本文档建立的 signal_input + selectedIndex 结构化 entries 是方案 B 的数据基础：

- 方案 B 下 `memory.getRecentAsMessages` 读 entries 时能合成带结构的 tool_call/tool_result 或扁平化文本，两种方式都依赖本文档的 payload
- 现状（挂起模式）下本文档也是独立价值的：历史可见 + 回溯铺路

实施顺序：先本文档 4 步 → 后方案 B。

---

## 不做的事

- **不动 `playthroughs.input_hint/choices/input_type` 三个快照字段**：它们承担"当前状态"，写 entries 时附带更新就行。restore 时用快照恢复 UI 是 O(1)，比扫 entries 找最后一条快
- **不重放历史工具调用给 LLM**：本次改造只持久化 signal_input_needed 一种工具事件，其他工具（update_state / change_scene 等）仍靠现在的 stateVars/currentScene/memorySnapshot 三快照间接保留。等方案 B 真动 messages 重建时再评估是否要存完整 tool_call 历史
- **不做 anchor 快照**：回溯（Step 5-6）需要的 per-signal state 锚点留待后续

---

## 验证清单

### 每个 commit 的底线

- `bun tsc --noEmit` 前端绿
- `cd server && bun tsc --noEmit` 后端绿
- `cd server && bun test` 全过（现有 ~95 tests）
- 新增 unit test 覆盖新行为

### Step 4 的 E2E

- 起一局 anjie，选 2-3 次选项
- 刷新页面 / 断开重连
- 打开 backlog 确认历史 signal_input + 高亮选择正确
