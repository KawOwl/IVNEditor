# GM 回合收尾可靠性 + tool 历史可见性 审计

**日期**：2026-04-24
**触发**：staging session `d429e833-f129-4e98-aeda-e5603529c1ba`（《暗街》3 turn 试玩）
**Langfuse**：http://39.108.85.114:30080/project/ivn-engine/sessions/d429e833-f129-4e98-aeda-e5603529c1ba

---

## 一、现象

三个 turn 的工具调用情况：

| Turn | finishReason | tools                                              | 问题 |
|------|--------------|----------------------------------------------------|------|
| 1    | tool-calls   | change_scene({sprites:[]}) + update_state + signal_input_needed | 正常 |
| 2    | tool-calls   | update_state + signal_input_needed                 | 正常 |
| 3    | **stop**     | **none**                                           | ❌ 纯叙事+停 |

用户输入：
- Turn 1: "开始游戏"
- Turn 2: "帕兹，战地记者，我想起来了。"
- Turn 3: "翻个跟头松松身子骨"

Turn 3 的 LLM 写完 351 字叙事就 `finishReason: stop`，完全没调收尾 tool。

---

## 二、根因分析

### 1. 没调立绘（change_sprite）— 行为正确，规则有缺口

- Turn 1 `change_scene(sprites:[])` 是剧本 `[prompt3-startup]` 里 "phase=INIT 第一轮 无立绘" 指令
- Turn 2/3 仍在 central_plaza，progress<2，`[prompt2-gate]` 不允许卡琳娜/卡尔/康纳出场
- POV 玩家设计上无立绘
- 所以**没立绘可切**

但规则缺口：
- ✅ "场景切换 → change_scene（含 sprites）"
- ✅ "情绪显著变化 → change_sprite"
- ✅ "角色下场 → clear_stage / visible=false"
- ❌ **角色首次进场（场景不变）→ 无明确规则**

progress 到 2 卡琳娜走到对话距离时，LLM 不知道该用哪个 tool 调出她的 sprite。

### 2. 最后一 turn 没调 signal_input_needed — Prompt 规则自相矛盾 + 引擎无兜底

剧本 `[prompt1-rules]` 绝对要求：
> 每轮用 signal_input_needed 给玩家 2–4 个差异化选项推进。

引擎 `[ENGINE RULES]` 给了逃逸口：
> **B. 自然结束回复**（仅当：玩家正在自由探索、描述具体行为细节、或当前场景更适合开放式独白时）

Turn 3 玩家 "翻个跟头松松身子骨" 正好命中 B 的 "描述具体行为细节"。LLM 按 B 走。

引擎层 AI SDK v6 的 generateText 看到 `finishReason: 'stop'` 就退出 step loop，**没有 stopWhen 兜底** 强制 "必须至少调一次收尾 tool"。

### 3. 【最严重】Tool call 历史全部被扔掉 — 放大了前两个问题

Turn 3 送给 LLM 的 input.messages：

```
[assistant] STRING content (350 字纯叙事)
[user]      STRING content ("帕兹，战地记者...")
[assistant] STRING content (572 字纯叙事)
[user]      STRING content ("翻个跟头松松身子骨")
```

**全是 string content，没有任何 tool-call / tool-result part**。

定位到 `src/core/memory/legacy/manager.ts:161`：

```ts
const raw = await this.reader.readRecent({
  limit: window,
  kinds: ['narrative', 'player_input'],   // 写死了，tool_call/signal_input 被过滤
});
```

`ChatMessage` 类型（`src/core/context-assembler.ts:36`）：

```ts
{ role: 'system' | 'user' | 'assistant'; content: string }   // 只能塞 string
```

后果：
- `tool_call` / `signal_input` entries 从读的那一刻就被过滤掉
- 即使不过滤，`ChatMessage.content: string` 也装不下 ToolCallPart/ToolResultPart
- `messages-builder.ts`（能正确生成 AI SDK ModelMessage）**在活线路径里根本没被调用**，只跑在测试和 `extractPlainText` 里

LLM 每一 turn 看到的历史都像是"纯小说叙事"，没有：
- 它自己上一轮给了什么 choices
- 玩家选的是哪条（仅看 user message 文本）
- 场景是什么、sprites 谁在场
- chapter/phase/progress 到哪一档（state 走 system 注入，不是历史）

---

## 三、修 tool 历史的目的

### 主要目的：用 in-context pattern 治本

Turn 3 丢 signal_input_needed 的**真正原因**不是"LLM 没读到规则"（规则在 system prompt 里），而是**它看到的最近几个 assistant turn 的 pattern 教坏了它**：

当前它看到的 recent messages 结构：
```
assistant: "阳光铺在广场..."       ← 纯叙事，没尾巴
user:      "帕兹，战地记者..."
assistant: "你拇指在证件边缘..."    ← 纯叙事，没尾巴
user:      "翻个跟头松松身子骨"
```

LLM 做 next token prediction，pattern 非常清晰：「assistant = 纯叙事，没有 tool call」。prompt 规则再怎么写"每轮必须 signal_input_needed"，敌不过两条 assistant 自己的历史示范。

应该让它看到的：
```
assistant: [text "阳光铺在广场..."] + [tool-call change_scene] + [tool-call signal_input_needed(choices=[...])]
tool:      [tool-result {success:true}] × 3
user:      "帕兹，战地记者..."
assistant: [text "你拇指在证件边缘..."] + [tool-call update_state] + [tool-call signal_input_needed(choices=[...])]
tool:      [tool-result ...] × 2
user:      "翻个跟头松松身子骨"
```

每个 assistant turn 都带 signal_input_needed 收尾。LLM 要续写第三个 assistant turn 时，pattern 贼强 —— 基本会跟着调 signal_input_needed。

这是 in-context learning 最本职的工作。当前架构相当于主动把教材撕了。

### 次要目的：Langfuse 一眼能看到 LLM 实际看到了什么

现在定位"turn N 的 LLM 是否知道 scene 是什么"需要拼：
- Langfuse trace → input.messages（只有 text）
- DB `narrative_entries` → tool_call 行
- DB `playthroughs.state_vars` → current_scene
- 脑子里对齐 orderIdx 和 batch

修完后：**Langfuse 的 input.messages 就是 ground truth**。调试效率翻倍。

### 澄清 —— 不是本次目的

- 不是为了让 LLM 记住 state 值（state injection 已做）
- 不是为了让 LLM 记住 current scene（focus injection 已做）
- 不是为了让 LLM 记住玩家选过什么（choice 文本已以 user message 形式在上下文里）

**这个修复不是补状态，是补 LLM 对自己行为历史的可见性。**

### 跟 stopWhen 的关系

**两个一起才完整**：
- 只改 prompt + 加 stopWhen：LLM 没调就被引擎强制续写一 step。续写那一 step 的 context 仍然缺 tool 历史，补调质量差
- 只修 tool history：90% 情况 pattern match 对，但偶尔还是漏调，没护栏
- 两个一起：**tool history 让 LLM 主动想调**，**stopWhen 兜住剩下 1% 漏调**，两次补调都有完整 context

---

## 四、优化建议（按 ROI 排）

### P0 · 修 tool 历史丢失（方案 A · 正本清源）

#### 数据流对比

**当前**：
```
NarrativeEntries (DB)
   ↓
LegacyMemory.getRecentAsMessages()
   reader.readRecent({ kinds: ['narrative','player_input'] })   ← bug #1
   ↓
ChatMessage[] { role, content: string }                          ← bug #2
   ↓
context-assembler → { systemPrompt, messages: ChatMessage[] }
   ↓
game-session: context.messages.map(m => ({ role: m.role, content: m.content }))
   ↓
generateText({ messages })
```

**目标**：
```
NarrativeEntries (DB)
   ↓
LegacyMemory.getRecentAsMessages()
   reader.readRecent({ kinds: ['narrative','player_input','tool_call','signal_input'] })
   buildMessagesFromEntries(entries)                             ← 已写好、有 20 个单测
   ↓
ModelMessage[]  (AI SDK 原生，assistant 带 ToolCallPart[]，新增 'tool' role)
   ↓
context-assembler → { systemPrompt, messages: ModelMessage[] }
   ↓
game-session: 直接透传，不 flatten
   ↓
generateText({ messages })
```

#### 具体改动

1. `src/core/context-assembler.ts`：删 `ChatMessage`，用 AI SDK 的 `ModelMessage`
2. `src/core/memory/types.ts`：`RecentMessagesResult.messages: ModelMessage[]`
3. `src/core/memory/legacy/manager.ts`：`getRecentAsMessages` 重写，读全 kinds，交给 messages-builder
4. `src/core/memory/llm-summarizer/manager.ts`：同样修
5. `src/core/memory/mem0/adapter.ts`：同样修
6. `src/core/game-session.ts`：去掉三处 `.map({role, content})` flatten（第 913 / 929 / 1025 行）
7. `src/core/memory/__tests__/legacy-memory.test.ts`：加 tool 历史往返测试

#### 关键细节

**orphan tool 处理**：messages-builder 生成 `[assistant with ToolCallPart, tool with ToolResultPart]` 连续对。budget 从尾往头砍时可能砍到一半只留 tool 丢 assistant —— provider 会报 `MissingToolResultsError`。需要 `pruneOrphanTool(kept)` 保护配对。

**Token 预算膨胀**：tool-call JSON 进历史后 token 消耗 +10–30%，recencyWindow 可能要从 20 降到 12–15。上线后观察再调。

**Provider 兼容**：AI SDK v6 默认 `wrapToolOutput: {type:'json', value}` 对 DeepSeek/Claude/OpenAI 都 safe。

**兼容性**：存量 playthrough 的 memorySnapshot 无 tool 历史，restore 后第一 turn 仍看不到 tool；从第二 turn 开始累积就有了。不 breaking。

#### 工作量

- 核心改动：2–3 小时
- 新增 + 调整测试：1–2 小时
- 手动 smoke（开 playthrough 看 Langfuse input.messages）：20 分钟
- 总计约半天

### P0 · 收尾兜底用引擎强制，不要靠 prompt

删 ENGINE RULES 里"路径 B 自然结束"整段。换成引擎端 stopWhen：

```ts
// game-session.ts 的 generateText 调用
stopWhen: async ({ steps }) => {
  const last = steps[steps.length - 1];
  // 收尾 tool 调过 → 可以停
  if (last.toolCalls?.some(c =>
    c.toolName === 'signal_input_needed' ||
    c.toolName === 'end_scenario'
  )) return true;
  // step 上限保护
  if (steps.length >= 4) return true;
  return false;  // 不然继续 step
}
```

配合 prompt 只留一条硬规则："回合必须以 signal_input_needed 或 end_scenario 之一收尾"。

### P1 · 补立绘进场规则

`[prompt1-rules]` 的【视觉工具使用】加一条：
> - **角色首次进入当前场景（无场景切换）时**，调 change_sprite 把 visible 设 true，同时给出初始 emotion。

### P1 · Prompt 结构重排

当前顺序：`prompt1-rules → prompt3-startup → prompt2-gate → prompt3-world → prompt3-attitude → ch1-phases → scene → [ENGINE RULES]`

两个问题：
1. `prompt2-gate`（许可门禁 · P0）排在 `prompt3-startup` 后面，但 gate 依赖 startup 已执行完 —— 优先级标 P0 却埋中间
2. `[ENGINE RULES]` 是唯一约束工具调用的硬规则，放在 13.8k 字末尾，recency bias 压给前面的 scene 段

建议顺序：
```
[ENGINE RULES / 回合收尾硬规则]   ← 最顶
[prompt1-rules] 叙事格式 + 工具调用
[prompt2-gate]  出场门禁（P0 放这里）
[scene_current] 当前场景（Focus Injection 注入）
[chN-phases 当前阶段]   ← 只注入当前阶段
[prompt3-attitude]
[prompt3-world]  ← 背景知识沉底
[prompt3-startup]  ← 只在 phase=INIT 注入，ACTIVE 条件去掉
```

`[prompt3-startup]` 一大段在 turn 2+ 已没用，每 turn 都发浪费 ~400 字。Focus Injection 条件化。

### P2 · 立绘规则本地化注入

场景段 `[scene_central_plaza]` 末尾注入一条"当前场上 sprites 清单"：

```
当前场上立绘（由 state.current_scene=central_plaza 推出）：
  - sprites: []（空 —— 玩家独自探索中）
  - 下次 change_sprite 可用 id：karina(facade/curious/authority/vulnerable), karl(resting/alert/speaking)
```

比把规则堆在 prompt1-rules 抽象描述更好用。

### P2 · 加 retry-on-missing-closer

即使上了 stopWhen，如果达到 step 上限仍没调收尾 tool，引擎做一次：
```
role: 'user'
content: '系统提示：上一条叙事没有以 signal_input_needed 或 end_scenario 收尾。请基于当前叙事状态追加一次收尾工具调用，不要重复叙事正文。'
```
再跑一次 generateText。低成本覆盖 LLM 偶尔 regression。

---

## 五、落地顺序

1. **立即**：方案 A 修 tool 历史（P0，最有价值单项）
2. **立即**：stopWhen 引擎兜底 + 删 Path B（P0）
3. **一起提**：立绘进场规则补丁 + prompt3-startup 条件注入
4. **下一轮**：prompt 结构重排 + 场上立绘锚点注入
5. **看需要**：retry-on-missing-closer

推荐 1 + 2 打包一个 PR（都是 engine 层，测试覆盖清晰，"引擎上下文 + 收尾兜底一起修"）。
