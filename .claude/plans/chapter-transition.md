# 章节切换机制 · 设计选型

> Status: **讨论中，未动工**
> 相关 issue: anjie trace `55f51e9e-...` 第一章结局后 LLM 调 `end_scenario`，
>   整个 playthrough 转 finished，没有进入第二章
> 相关文件:
>   - `src/core/game-session.ts`（coreLoop）
>   - `src/core/tool-executor.ts`（工具定义）
>   - `src/core/focus.ts`（Focus Injection 感知）
>   - `server/scripts/seed-anjie.ts`（prompt 层指令）

---

## 背景 · 现状诊断

### 数据结构层

```ts
interface ScriptManifest {
  chapters: ChapterManifest[];   // 按章节分组的 segments
  ...
}
interface ChapterManifest {
  id: string;                    // 'ch1', 'ch2', ...
  label: string;
  flowGraph: FlowGraph;
  segments: PromptSegment[];
}
```

所以章节本身是"编辑器组织内容的方式"，runtime 只把所有章节的 segments
flat 起来一起用：

```ts
// session-manager.ts buildConfig()
const allSegments = manifest.chapters.flatMap((ch) => ch.segments);
```

### 运行时章节感知

实际区分"当前第几章"完全靠 **state 变量 + injectionRule 过滤**：

```ts
// seed-anjie.ts chapterSegment helper
injectionRule: {
  description: `仅第 ${chapter} 章`,
  condition: `chapter === ${chapter}`,
}
```

- `state.chapter`（number，初值 1）是事实上的章节指针
- `ch1-phases` / `ch2-intro` / `ch3-intro` 这类章节级内容靠 injectionRule 过滤
- 跨章节的"场景段"（如 `scene-apartment`、`scene-karinas-apartment`）没 injectionRule，会被所有章节共用

### 当前的失败模式

1. anjie seed 的 `SYSTEM_RULES` + `CH1_PHASES` 告诉 LLM：
   > "达成整章退出信号调 end_scenario"
2. 但 `end_scenario` 的语义是**整个剧本结束**（`tool-catalog.ts` 明确写着
   "only when the story has definitively concluded"），不是章节转场
3. LLM 照做了 → playthrough 转 `finished` 状态
4. **没有第二章**

**更深的问题**：就算 LLM 改成调 `update_state({chapter: 2})`，当前 Focus
Injection D（见 `vn-catch-up.md` 和 `focus-injection.md`）的 `computeFocus`
只读 `current_scene`，`chapter` 改了也不会触发 `prepareStep` 重新 assemble。
新章节的 segments 进不了 system prompt。

---

## 方案维度

做决策前把问题切成三个正交的维度。

### 维度 A · 谁触发切章？

| 选项 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **A1** · LLM 调 `update_state({chapter: N+1})` | 零新工具，纯 prompt 指示 | 零引擎改动；未来新章节不需要工具扩展 | LLM 自觉判断"何时切"；可能漏调/错调；state 变化的触发语义不明显 |
| **A2** · 引擎根据 manifest 配置的 exit condition 自动切 | manifest 加 `chapters[].exitCondition: string`，coreLoop 监听 | 机制确定；LLM 行为不变 | manifest 要扩 schema；编辑器要配置 condition；"prompt 里写的退出信号"和"condition 表达式"双轨易走样 |
| **A3** · 新工具 `transition_chapter({to, reason})` | LLM 调显式工具，引擎处理切换副作用 | 语义清晰；和 `end_scenario` 不会混；Langfuse 有明确 trace event；未来可扩展参数（保留/重置内存等） | 多一个工具；prompt 要教 LLM 区分 transition vs end_scenario |
| **A4** · 复用 `end_scenario`，根据 state.chapter 自动判断 | 当前 chapter < 总数 → 切；否则真结束 | LLM 行为不变 | 同一个 tool 两种行为，语义暧昧；tool 名和实际行为背离 |

### 维度 B · 切章后做什么

| 选项 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| **B1** · 纯重 assemble | state.chapter 变 → prompt 重建 → 新章节 segments 进入 | 最小改动；和 Focus Injection D 机制吻合 | "章节切换"对玩家体验上可能没有仪式感 |
| **B2** · 重 assemble + 内存硬重置 | 清掉上一章的 recent history，只留压缩 summary | 避免上一章细节吃 token | 风险：LLM 可能因为失去前文直接叙事断层 |
| **B3** · 重 assemble + VN 章节转场动画 | 插入 scene_change Sentence + 前端渲染章节标题卡（"第二章 · 余波与抉择"淡入淡出） | 体验好；传统 VN 就这么做 | 前端工作量；先跑通逻辑再做 polish |
| **B4** · 不做真正"切"，章节只是 injectionRule 分组 | 所有章段并存，靠条件过滤自然切换 | 最简单 | 缺失"章节边界"这个叙事/UX 概念 |

### 维度 C · Focus Injection 如何感知 chapter 变化

| 选项 | 描述 | 实施成本 | 通用性 |
|---|---|---|---|
| **C1** · `computeFocus` 读 state.chapter 放进 FocusState | `FocusState` 加 `chapter?: string\|number`；focusKey 含 chapter → 变化时 prepareStep 重 assemble | ~10 行代码 | 仅支持 chapter 这一个字段，特殊化 |
| **C2** · manifest 加 `assemblyVars: string[]` 列出关键 state | 任意字段变化都能触发重 assemble | 中等（schema 扩 + 编辑器 UI） | 通用，覆盖未来其他 progression 变量 |
| **C3** · 每步都重 assemble（放弃 cache） | 任何 state 变化自动反映 | 零代码 | 丢了 prompt cache 命中率，成本高 |

---

## 推荐组合 · A3 + B1 + C1

最平衡的组合：

### A3 · 新工具 `transition_chapter`

```ts
// src/core/tool-executor.ts 新增
tools['transition_chapter'] = handler(
  'transition_chapter',
  z.object({
    to: z.string().describe('目标章节 id（需匹配 manifest.chapters[].id）'),
    reason: z.string().optional().describe('章节退出的原因摘要'),
  }),
  async (args) => {
    const { to, reason } = args as { to: string; reason?: string };
    if (!ctx.onChapterTransition) return { success: false, error: 'Not supported' };
    const result = await ctx.onChapterTransition(to, reason);
    return result;
  },
);
```

`game-session` 挂 `onChapterTransition`：
- 校验 `to` 是合法 chapter id
- `stateStore.set('chapter', chapterNumber)`
- 记 Langfuse event `chapter-transition`
- 可选：emit 一条特殊 scene_change Sentence 让前端有机会渲染转场
- return `{ success: true, chapter: N }`

**和 `end_scenario` 的区分（在 tool description 里写清）**：
- `transition_chapter`：章节结束但故事继续（进入下一章）
- `end_scenario`：整个剧本真正结束（玩家走到终局/分道扬镳）

### B1 · 纯重 assemble

切章后不做额外动作（内存保留、前端不做转场动画）。依赖 C1 让 Focus Injection
感知到 `state.chapter` 变化，下一个 step 的 `prepareStep` 重新 assemble。

**前端体验**：玩家点下一个选项 → LLM 开始生成新章叙事 → 自然过渡。没有"章节
标题卡"的仪式感但逻辑上正确，够用。

### C1 · `computeFocus` 读 chapter

```ts
// src/core/focus.ts
export function computeFocus(stateVars: Record<string, unknown>): FocusState {
  return {
    scene: typeof stateVars.current_scene === 'string' ? stateVars.current_scene : undefined,
    // chapter 进 focus：chapter 变化会改变 focusKey → prepareStep 会重 assemble
    // 不参与 scoreSegment 匹配（segment 没有 focusTags.chapter），只作为
    // "触发重 assemble" 的信号
    chapter: typeof stateVars.chapter === 'number' ? stateVars.chapter : undefined,
  };
}
```

`FocusState` 加 `chapter?: string | number`。  
`scoreSegment` 不改（不匹配 chapter 字段）。  
`game-session` 里的 `focusKey` 已经用 `JSON.stringify({ scene, chars, stage })`，
加上 chapter 即可。

---

## 配套改动

### `seed-anjie.ts` prompt

**SYSTEM_RULES 章末提示**：
```
章节结束信号达成时：
  - 使用 transition_chapter({ to: "ch2" }) 进入下一章（第一章 → 第二章等）
  - 只在**整个剧本真正结束**（分道扬镳、全部结局达成）时调 end_scenario
```

**CH1_PHASES 阶段六**：
```
结局分支触发后：
  ≥2 共犯/记录者结局 + 想进第二章 → transition_chapter({ to: "ch2", reason: "共犯结局达成" })
  ≤0 分道扬镳 / 玩家真的离开新西西里 → end_scenario({ reason: "..." })
```

**CH2_INTRO 阶段五**：同样的 transition_chapter 指向 `ch3`。  
**CH3_INTRO**：所有结局都走 `end_scenario`。

### 需要新建/修改的文件清单

| 文件 | 改动 |
|---|---|
| `src/core/focus.ts` | `computeFocus` 加 chapter |
| `src/core/types.ts` | `FocusState` 加 `chapter?` |
| `src/core/tool-executor.ts` | 新增 `transition_chapter` 工具 |
| `src/core/tool-catalog.ts` | 工具列表加 `transition_chapter`；tighten `end_scenario` 描述 |
| `src/core/game-session.ts` | `ToolContext` 加 `onChapterTransition`；实现切章副作用 |
| `server/scripts/seed-anjie.ts` | prompt 层用 transition_chapter + enabledTools 加这个工具 |
| `src/core/__tests__/` | 单测：chapter 变化触发 prepareStep 重 assemble；transition_chapter 更新 state |

### 测试点

- 单测 · `computeFocus({chapter: 2})` 返回含 `chapter: 2` 的 FocusState
- 单测 · `transition_chapter({to: 'ch2'})` 把 `state.chapter` 设到 2
- 单测 · 非法 `to`（chapters 里没这个 id）返回 error，state 不动
- 集成 · prepareStep 在 chapter 变化时 cachedFocusKey 失效 → 重 assemble
- E2E（留到 staging） · 玩到 ch1 结尾 LLM 调 transition_chapter → 下轮 prompt 含 `ch2-intro` 段

---

## 待决定项

1. **transition 过程是否要 emit 一条特殊 `chapter_transition` Sentence**  
   前端有机会做"章节标题卡"动画。MVP 不做，后面 polish 可以加。

2. **transition 时是否要给 LLM 一个"你刚进入第 N 章"的系统消息**  
   如果不加，LLM 可能在新章第一步还在延续上一章的语气。可以：
   - 在 ch2-intro 段里写"本段仅在 chapter >= 2 时激活"—— 段一生效 LLM 自然感知
   - 或 transition_chapter 的 tool_result 带 `{ success: true, new_chapter_intro: "..." }` 直接提示

3. **是否允许 `transition_chapter` 跳章（ch1 → ch3）**  
   当前语义是"切到下一章"。但 API 接收任意 `to` id。两种思路：
   - 严格：只允许 chapter+1（跳章返回 error）
   - 宽松：任意合法 id（给编剧灵活度，例如某些分支跳过中间章节）
   
   倾向宽松，多出来的灵活度几乎零成本。

4. **切章是否触发 narrative_entries 的分隔标记**  
   目前所有 entry 混一个列表。加个 `chapter: number` 列方便未来按章查询。
   MVP 不做也行，等有需求再加。

---

## 不采纳的方案（记录理由）

- **A1（单 update_state）** — LLM 自觉性不可靠，没有显式工具语义
- **A2（manifest exit condition）** — 要扩 manifest schema + editor UI，重
- **A4（复用 end_scenario）** — 同名两语义，编辑器/调试混乱
- **B2（内存硬重置）** — 有 LLM 失去前文的风险，章节衔接体验差
- **C2（manifest.assemblyVars）** — 过早通用化，当前只有 chapter 一个场景
- **C3（每步重 assemble）** — 丢 prompt cache
