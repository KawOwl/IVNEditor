# VN 对话框 Auto-Advance（catchUpPending）机制

> Status: **已上线 v15**（2026-04-23）
> Scope: VN 对话框在流式叙事场景下的游标推进行为
> 相关文件:
>   - `src/stores/game-store.ts`（状态机）
>   - `src/ui/play/vn/VNStageContainer.tsx`（UI 消费）
>   - `src/stores/__tests__/game-store-catchup.test.ts`（状态机测试）

---

## 问题背景

我们有个 VN 风格对话框，玩家点击/空格推进游标到下一条 Sentence。Sentence 流式
到达（LLM 一段段生成）。

**玩家的典型流程**：
1. 选了一个选项（signal_input_needed 的 choice）
2. 等 LLM 开始生成（对话框显示"生成中..."）
3. 新 Sentence 陆续到达
4. 玩家想看到新内容，不想盯着空白

**如果完全不做 auto-advance**：玩家点最后一次后留在旧 Sentence，新 Sentence
到了**不会自动显示**，玩家盯着"同一个旧对话框"，不知道内容已经来了。体验差。

**如果每次新 Sentence 都自动推进**：一批新 Sentence 流式到达（典型 5-10 条），
游标**连续链式触发**，玩家只看到最末一条，前面的都被无声跳过。更差。

---

## 设计目标

- 玩家**点到末端 / 选完选项 / 开局**后处于"等内容"状态
- 第一条新 Sentence 到达时**自动显示**（这是"追赶"）
- 之后的 Sentence **等玩家手动点**推进，一次看一条
- 玩家**往回翻 backlog**时，新 Sentence 来不打扰游标

---

## 方案：`catchUpPending` 一次性触发门闸

### 状态字段

```ts
interface GameState {
  ...
  visibleSentenceIndex: number | null;   // 游标位置
  catchUpPending: boolean;               // 有待执行的 catch-up
}
```

语义：`catchUpPending === true` 表示"玩家刚做过主动动作，欠他一次追赶"。像一个
CS 领域的 pending task —— 排着队等条件满足。

### 状态转移图

```
初始 catchUpPending = true
   │
   ▼
┌──────────────────────────────────────────┐
│           catchUpPending = true           │◄─── 玩家主动动作：
│  （等一次 catch-up）                       │       advanceSentence（点/按键）
│                                           │       setVisibleSentenceIndex（跳）
└─────────────────────┬─────────────────────┘       seedOpeningSentences
                      │                             reset
                      │ appendSentence 且满足：
                      │   - 玩家 vsi 在末端
                      │   - 新 Sentence 不是 scene_change
                      │
                      ▼
┌──────────────────────────────────────────┐
│           catchUpPending = false          │
│  （已经 catch-up 一次，等玩家再激活）       │
│                                           │
│  appendSentence 新 Sentence 到达 → 不动    │
└──────────────────────────────────────────┘
```

### 触发条件（`appendSentence` 中判定）

```ts
const canCatchUp =
  catchUpPending &&                         // 门闸开着
  playerAtTail &&                           // 玩家在当前末端
  sentence.kind !== 'scene_change';         // scene_change 不应占 click

if (canCatchUp) {
  vsi = 新末端;
  catchUpPending = false;    // 击发一次，关门闸
}
```

### 不触发（保留 pending 状态）的情形

- **玩家往回翻 backlog**（`vsi < prev.length - 1`）→ 不在末端，不打扰
- **新 Sentence 是 scene_change**（背景/立绘自动更新，不需要玩家点击）
- **`catchUpPending === false`**（上次已经 catch-up 过了）
- **初始化**（vsi 从 null → 0 本身就算 catch-up 了，置 pending=false）

### Re-arm（重置为 true）的情形

**任何"玩家主动推进"都 re-arm**：

| Action | 为什么要 re-arm |
|---|---|
| `advanceSentence`（玩家点击/空格/方向键） | 玩家表达"我在推进"，如果再次到末端欠他下次 catch-up |
| `setVisibleSentenceIndex`（跳到某条，backlog 用） | 同上 |
| `seedOpeningSentences`（剧本开场塞 opening messages） | 开场刚到 vsi=0，玩家可能点几下读完 opening，然后 LLM 开始生成 —— 欠他一次 catch-up |
| `reset`（剧本重开） | 干净状态，重新开始 |

---

## 为什么不用 `lastAdvanceSource: 'manual' \| 'auto'`

首先尝试的设计是记录"上一次游标变化是谁引起的"，两态字符串。但这**表达的是事后
追溯**（who did it last），要推导"能不能再自动"需要转一道弯：

```
if (上次是 manual) → 可以 auto
if (上次是 auto) → 不能再 auto
```

读代码的人看到 `source === 'manual'` 得反推"为什么要检查这个？哦原来是为了限制
auto 连续触发"。

`catchUpPending` **直接表达触发资格**（can it fire），一眼看懂。语义上 catch-up
是一个"pending job"，要么排队、要么完成 —— 这个隐喻在 CS 里很常见。

---

## 为什么不用"打字机完成 + 队列非空"触发

替代方案是：当当前 Sentence 的打字机动画完成、又有下一 Sentence 时自动推进。
看似更直接：

```
打字机 done + 有下一条 → 推 1 格 → 新一条的打字机开始 → done → 推 1 格 ...
```

问题：**链式触发**回来了。如果 LLM 快速吐 10 条 Sentence 且玩家的打字机跑得比
LLM 还快（cps=50、每段 100 字 → 打字机 2s、LLM 某些 provider 慢），玩家全程看
到的就是"打字机每跑完一段自动跳下一段"，跟 auto-play 一个效果。

user 明确说"只要前进一个 sentence 就好了"—— 意思是 "一次一格"不是 "持续 auto-
play"。catchUpPending 的一次性语义更贴。

---

## 不冲突的设计：未来 Auto-Play 模式

如果将来真加 VN 风格"**自动播放模式**"（打字机完 + 延时 N 秒 + 自动推 + 循环），
它是**独立 feature**，加个独立 state：

```ts
interface GameState {
  ...
  catchUpPending: boolean;          // 本次 design，一次性追赶
  autoPlayMode?: boolean;           // 未来 design，持续自动播放
}
```

逻辑分层：

```ts
if (autoPlayMode) {
  // 打字机 done → wait delayMs → advance → repeat
} else if (catchUpPending) {
  // 一次性追赶（本 design）
} else {
  // 纯手动
}
```

两个 flag 语义独立，`catchUpPending` 不会和 "auto-play" 的 "auto" 撞名。

---

## 测试（`game-store-catchup.test.ts`）

6 个 test 覆盖完整状态机：

1. **初始 pending=true，vsi=null** —— 初值对
2. **第一条 Sentence 到达**：init 到 vsi=0 + pending=false
3. **连续新 Sentence**：第一次 catch-up 成功，之后不再链式触发
4. **玩家主动 advance 重新 arm**：玩家点击后 pending=true，下次新 Sentence 又能 catch-up
5. **scene_change 不触发 catch-up**：pending 保持，等下一条 narration/dialogue
6. **玩家往回翻 backlog**：新 Sentence 不打扰游标

---

## 边界情况

- **连续多个 scene_change 堆积**（无 narration/dialogue）：backgrounds 在变，对话框保持旧内容。pending 保持 true，等真正 narration 来时再 catch-up。
- **打字机正在跑当前 Sentence + catch-up 触发**：当前设计下 catch-up 会把 vsi 换成新末端 —— 打字机切到新 Sentence。用户会看到当前 Sentence 显示被"打断"。实际体验下还 OK，因为玩家本来就在等新内容。如果有反馈说不好，再考虑"先等当前打字机完成再 catch-up"。
- **网络抖动重连 / session restore**：`restore` 从 DB 读 entries 恢复 parsedSentences，setVisibleSentenceIndex 把游标设到末端 + pending=true。下次新 Sentence 来时正常 catch-up。

---

## 未来改进方向

- **打字机感知 catch-up**：等当前 Sentence 打字机完成再触发，避免"打断阅读"
- **配置化**：catch-up 可以做成"只在 pending=true + 打字机完成 + 手动启用"，给玩家一个"不打扰"选项
- **auto-play 模式**：按上面说的独立 flag 实现，典型 VN 的"标题栏开关"
