# 项目进度

## 当前状态
Phase 1 完成。所有 10 个步骤（1.0–1.9）已实现并通过 typecheck + build。下一步：Phase 2 Architect Agent 或用 MODULE_7 剧本进行端到端验证。

## 整体计划

| Phase | 内容 | 状态 | 进度 |
|-------|------|------|------|
| Phase 1 | 执行引擎核心 | done | 100% |
| Phase 2 | Architect Agent | pending | 0% |
| Phase 3 | Visual Flow Editor | pending | 0% |
| Phase 4 | 完善 | pending | 0% |

## 功能清单

### Phase 1: 执行引擎核心

| Step | 功能 | 状态 | 备注 |
|------|------|------|------|
| 1.0 | 项目脚手架 | done | React 19 + TS 6 + Vite 8 + Tailwind 4 + shadcn/ui |
| 1.1 | 类型定义 (core/types.ts) | done | types.ts + schemas.ts (Zod v4) |
| 1.2 | StateStore + Changelog | done | Changelog 独立存储，CRUD 查询 |
| 1.3 | MemoryManager | done | append / compress / pin / query |
| 1.4 | ContextAssembler | done | token 预算 + segment 注入 |
| 1.5 | ToolExecutor | done | 11 个工具注册 + 执行 |
| 1.6 | LLM Client | done | AI SDK v6 streamText + tools + stopWhen |
| 1.7 | FlowExecutor | done | FlowGraph 遍历 + 节点执行 |
| 1.8 | 基础 UI | done | NarrativeView + InputPanel + DebugPanel + GameStore |
| 1.9 | GameSession 集成 | done | 端到端集成层 + createGameStarter |

### Phase 2: Architect Agent

| Step | 功能 | 状态 | 备注 |
|------|------|------|------|
| 2.1 | 文档上传 + 分类 | pending | - |
| 2.2 | 状态变量提取 Agent | pending | - |
| 2.3 | 流程结构提取 Agent | pending | - |
| 2.4 | Prompt 拆分 Agent | pending | - |
| 2.5 | 注入规则生成 Agent | pending | - |
| 2.6 | 工具启用 + Schema 生成 | pending | - |
| 2.7 | 记忆策略生成 Agent | pending | - |
| 2.8 | Agent 结果预览 + 确认 UI | pending | - |

### Phase 3: Visual Flow Editor

| Step | 功能 | 状态 | 备注 |
|------|------|------|------|
| 3.1 | ReactFlow 集成 | pending | - |
| 3.2 | 节点编辑面板 | pending | - |
| 3.3 | 边/条件编辑器 | pending | - |
| 3.4 | Prompt 片段编辑器 | pending | - |
| 3.5 | 跨章继承确认界面 | pending | - |

### Phase 4: 完善

| Step | 功能 | 状态 | 备注 |
|------|------|------|------|
| 4.1 | 存档/读档 | pending | IndexedDB + segment ID + 版本号 |
| 4.2 | 剧本版本检测 | pending | segment 哈希比对 + 变化提示 |
| 4.3 | 跨章继承 | pending | 三层 fallback + 继承快照 |
| 4.4 | Debug 面板增强 | pending | changelog viewer + token viz |
| 4.5 | MODULE_7 端到端验证 | pending | - |

## 当前正在做的功能
**Phase 1 完成，待验证**
- Phase 1 所有模块已实现：types, schemas, StateStore, MemoryManager, ContextAssembler, ToolExecutor, LLMClient, FlowExecutor, GameSession, UI (NarrativeView + InputPanel + DebugPanel + GameStore)
- 下一步可以用 MODULE_7 剧本手写 IR 进行端到端验证，或进入 Phase 2

## 关键决策记录

| 日期 | 决策 | 原因 | 影响 |
|------|------|------|------|
| 2026-03-31 | GM 从文本生成器改为 Agentic（tool use） | 结构化保证、时序精确、查询能力 | 新增 ToolExecutor 模块，11 个工具 |
| 2026-03-31 | Changelog 独立存储，不属于 ScriptState | GM 大多数轮次不需要看，按需 CRUD 查询 | 新增 query_changelog 工具 |
| 2026-03-31 | Segment 分 content/logic 类型 | logic 变化才触发重算激活列表 | Architect Agent 提取时需标记类型 |
| 2026-03-31 | 跨章继承三层 fallback | 编剧可以不显式声明，Agent 自动推断兜底 | 需提醒编剧未声明字段会被自动继承 |
| 2026-03-31 | signal_input_needed 由 GM 自主调用 | GM 控制停顿时机更灵活，通过 prompt 调节 | 不再固定每轮必须等玩家输入 |
| 2026-03-31 | UI 选型 shadcn/ui | 底层自带 Radix + Tailwind，缺口再补 Radix | 不单独安装 Radix UI |

## 遗留问题 / 待讨论
- [ ] Phase 3 的 Visual Flow Editor 详细交互设计（之前暂缓）
- [ ] 编辑器"/"菜单工具引用的具体实现方案
