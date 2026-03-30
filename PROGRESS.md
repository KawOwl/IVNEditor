# 项目进度

## 当前状态
v2.0.md 已重写，忠实还原设计讨论决策。旧代码需要重写以匹配新架构。

## 当前任务
**重写核心循环代码**
- 类型：重构 / 重写
- 来源：发现实现与设计讨论存在根本性偏离（FlowExecutor 节点驱动 vs LLM Agentic 驱动）
- 目标：删除旧的 FlowExecutor / GameSession / FlowGraph 运行时逻辑，按重写后的 v2.0.md 重新实现核心循环
- 进展：v2.0.md 已重写完成并提交

## 关键决策记录

| 日期 | 决策 | 原因 | 影响 |
|------|------|------|------|
| 2026-03-31 | GM 从文本生成器改为 Agentic（tool use） | 结构化保证、时序精确、查询能力 | 新增 ToolExecutor 模块，11 个工具 |
| 2026-03-31 | Changelog 独立存储，不属于 ScriptState | GM 大多数轮次不需要看，按需 CRUD 查询 | 新增 query_changelog 工具 |
| 2026-03-31 | Segment 分 content/logic 类型 | logic 变化才触发重算激活列表 | Architect Agent 提取时需标记类型 |
| 2026-03-31 | 跨章继承三层 fallback | 编剧可以不显式声明，Agent 自动推断兜底 | 需提醒编剧未声明字段会被自动继承 |
| 2026-03-31 | signal_input_needed 由 GM 自主调用 | GM 控制停顿时机更灵活，通过 prompt 调节 | 不再固定每轮必须等玩家输入 |
| 2026-03-31 | UI 选型 shadcn/ui | 底层自带 Radix + Tailwind，缺口再补 Radix | 不单独安装 Radix UI |
| 2026-03-31 | 功能清单迁移至 feature_list.json | JSON 比 Markdown 更不易被意外改写，跨会话更可靠 | PROGRESS.md 只保留当前任务和决策记录 |
| 2026-03-31 | tool-executor 使用 zod/v4，llm-client 用 zodSchema() 包装 | AI SDK v6 内置转换器不支持 Zod v4 的 _zod 结构，需显式 zodSchema() | 所有工具参数定义保持 zod/v4，仅转换层加包装 |
| 2026-03-31 | update_state 工具参数改为 JSON string | z.record() 在 Zod v4 → JSON Schema 转换中生成 type:null | LLM 传 JSON 字符串，tool-executor 内部 parse |
| 2026-03-31 | 重写 v2.0.md，删除 FlowExecutor 节点驱动设计 | 实现偏离了设计讨论决策：Turn 6 被拒绝的 YAML Flow 概念（5 种节点类型、边条件求值）被错误引入 v2.0.md | 核心循环改为 Generate + Receive，FlowGraph 降级为可视化参考图 |
| 2026-03-31 | 引擎层术语中性化：GM/PC → Generate/Receive | GM/PC 是桌游术语，引擎不应绑定特定交互模式。引擎只关心 Generate（LLM 产出内容）和 Receive（接收外部输入） | 记忆条目 role 改为 'generate'/'receive'，编剧在 Prompt 中自由命名角色 |

## 遗留问题 / 待讨论
- [ ] 编辑器"/"菜单工具引用的渲染优化（当前为纯文本 {{tool:xxx}}）
- [ ] Architect Agent pipeline 尚未与 UI 端到端连接（当前 e2e 使用手写 IR fixture）
- [ ] 存档读档功能已实现但未在 e2e 中验证（需 UI 入口）
