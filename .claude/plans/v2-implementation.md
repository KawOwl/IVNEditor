# v2.0 实现计划

## 技术栈

- **框架**: React 19 + TypeScript 5.7 + Vite 6
- **状态管理**: Zustand 5
- **数据验证**: Zod 3
- **AI SDK**: Vercel AI SDK (`ai` + `@ai-sdk/openai-compatible`)
- **存储**: IndexedDB (via `idb`)
- **UI**: Tailwind CSS 4 + Radix UI
- **流程图（Phase 3）**: ReactFlow

---

## Phase 1: 执行引擎核心（手动构造 IR 测试）

目标：不依赖 Architect Agent，用手写的 IR JSON 驱动完整的 Generate/Receive 循环。完成后可以用 MODULE_7 的数据手动跑通一个最小对话。

### Step 1.0: 项目脚手架
- `pnpm init` + 安装依赖（react, vite, zustand, zod, ai, idb, tailwindcss）
- 配置 tsconfig, vite.config, tailwind
- 创建目录结构：
  ```
  src/
    core/           # 引擎核心（纯逻辑，不依赖 React）
      types.ts        # 所有 IR 类型定义（FlowGraph, PromptSegment, StateSchema 等）
      state-store.ts  # ScriptState + Changelog
      memory.ts       # MemoryManager（append / getRecent / compress）
      context-assembler.ts  # token 预算 + segment 注入
      tool-executor.ts      # 工具注册 + 执行
      flow-executor.ts      # FlowGraph 遍历 + 节点执行
      llm-client.ts         # AI SDK wrapper
    ui/             # React UI
      App.tsx
      NarrativeView.tsx    # 流式文本渲染
      InputPanel.tsx       # 玩家输入
      DebugPanel.tsx       # 状态/记忆/token 查看器
    store/          # Zustand stores
      game-store.ts        # 全局游戏状态（连接 core 和 ui）
    storage/        # IndexedDB 持久化
      idb.ts
    fixtures/       # 手写的测试 IR 数据
      module7-test.json    # MODULE_7 的手动 IR
  ```

### Step 1.1: 类型定义 (`core/types.ts`)
- 定义所有 IR 接口：FlowGraph, FlowNode, FlowEdge, PromptSegment, InjectionRule, StateSchema, StateVariable, MemoryConfig, CrossChapterConfig
- 定义四层状态接口：ProgressState, ScriptState, MemoryState, RuntimeState
- 定义 Changelog 条目接口：ChangelogEntry
- 定义工具接口：ToolDefinition, ToolCallResult
- 用 Zod 做运行时验证 schema

### Step 1.2: StateStore + Changelog (`core/state-store.ts`)
- ScriptState: get / set / update(patch) / serialize(toYAML)
- Changelog: append / query(filter) — 独立存储，CRUD 查询
- update(patch) 内部同时写 state 和 changelog（原子性）
- export / import（存档 / 跨章）

### Step 1.3: MemoryManager (`core/memory.ts`)
- appendTurn(entry) — 追加记忆条目
- getRecent(n) — 获取最近 n 条
- getSummaries() — 获取压缩摘要
- compress(hintPrompt?) — 触发压缩（调用 LLM）
  - 保留 recencyWindow 条原文
  - 其余生成摘要
  - 摘要过长时合并
- pin(content, tags) — 标记重要记忆
- query(text) — 语义搜索（初期用关键词匹配，后续可接向量搜索）
- getTokenCount() — 当前总 token 数
- 压缩时可从 Changelog 拉取相关条目作为参考

### Step 1.4: ContextAssembler (`core/context-assembler.ts`)
- assemble(node, state, memory, segments, budget) → messages[]
- 按 injectionRule 筛选 segment
- 按 priority 排序
- 注入 state YAML
- 注入 memory summaries + recent history
- token 预算裁剪：system > summary > recent > context

### Step 1.5: ToolExecutor (`core/tool-executor.ts`)
- registerTool(name, schema, handler)
- 预置 11 个工具的 handler：
  - 必选：update_state, signal_input_needed
  - 可选：read_state, query_changelog, pin_memory, query_memory, inject_context, list_context, advance_flow, set_mood, show_image
- executeTool(name, args) → result
- getToolDefinitions(enabledTools) → AI SDK tool definitions

### Step 1.6: LLM Client (`core/llm-client.ts`)
- 封装 AI SDK 的 streamText
- 支持 tools + maxSteps（agentic loop）
- 返回流式文本 + tool call 事件
- 可配置 model / provider

### Step 1.7: FlowExecutor (`core/flow-executor.ts`)
- 加载 FlowGraph
- 按节点类型执行：
  - scene → ContextAssembler + LLM Client（agentic loop）+ Memory.append
  - input → 等待玩家输入 → Memory.append
  - compress → Memory.compress
  - state-update → StateStore.update
  - checkpoint → 自动存档
- 边遍历：求值 condition，选择下一个节点
- 循环检测（回边 + 安全上限）

### Step 1.8: 基础 UI
- **NarrativeView**: 流式文本渲染（支持 Markdown），处理 text/tool_call 交错流
- **InputPanel**: 自由文本输入 + 选项按钮
- **DebugPanel**: 折叠面板，显示当前 ScriptState、Changelog、Memory entries/summaries、token usage
- **game-store.ts**: Zustand store 连接 FlowExecutor 和 UI

### Step 1.9: 手写 MODULE_7 测试 IR + 端到端跑通
- 手动创建 module7-test.json：包含简化的 FlowGraph（3-4 个节点）、几个 PromptSegment、StateSchema
- 跑通完整循环：加载 IR → 执行 scene 节点 → GM 生成 + tool call → 玩家输入 → 下一轮

---

## Phase 2: Architect Agent（文字 → IR）

目标：编剧上传 Markdown 文档，Agent 自动提取 IR 结构。

### Step 2.1: 文档上传 + 分类
- 文档上传 UI（拖拽 .md 文件）
- 分类 Agent：识别文档类型（gm_prompt / pc_prompt / world_data / location_data）

### Step 2.2: 状态变量提取 Agent
- 从 GM Prompt 中提取 StateSchema
- 输出 StateVariable[]

### Step 2.3: 流程结构提取 Agent
- 从 GM Prompt 的阶段地图提取 FlowGraph
- 输出 FlowNode[] + FlowEdge[]

### Step 2.4: Prompt 拆分 Agent
- 将大文档拆分为 PromptSegment[]
- 标记 type（content / logic）
- 计算 contentHash
- 估算 tokenCount

### Step 2.5: 注入规则生成 Agent
- 从条件性描述提取 InjectionRule[]
- 关联到对应的 PromptSegment

### Step 2.6: 工具启用列表 + Schema 生成
- 从编剧的工具使用指南提取启用的工具列表
- 根据 StateSchema 自动生成 update_state 的参数 schema

### Step 2.7: 记忆策略生成 Agent
- 提取 MemoryConfig + CrossChapterConfig

### Step 2.8: Agent 结果预览 + 编剧确认 UI
- 展示提取结果（列表 + 简单预览）
- 编剧可以接受/拒绝/手动修正

---

## Phase 3: Visual Flow Editor

目标：可视化编辑 FlowGraph + PromptSegment。

### Step 3.1: ReactFlow 集成 + FlowGraph 渲染
### Step 3.2: 节点编辑面板（点击节点 → 侧栏编辑）
### Step 3.3: 边/条件编辑器
### Step 3.4: Prompt 片段编辑器
### Step 3.5: 跨章继承可视化确认界面

---

## Phase 4: 完善

### Step 4.1: 存档/读档（IndexedDB，含 segment ID 列表 + 剧本版本号）
### Step 4.2: 剧本版本更新检测（segment 哈希比对 + 变化提示）
### Step 4.3: 跨章继承（三层 fallback + 继承快照）
### Step 4.4: Debug 面板增强（changelog viewer + token visualization）
### Step 4.5: MODULE_7 端到端验证

---

## 实施顺序建议

**先做 Phase 1**（执行引擎核心），按 Step 1.0 → 1.9 顺序。这是整个系统的基础，完成后就有一个可运行的引擎。

Phase 2 和 Phase 3 可以在 Phase 1 完成后并行推进（Agent 和 Editor 互相独立）。

Phase 4 在 Phase 1 基本稳定后逐步补充。
