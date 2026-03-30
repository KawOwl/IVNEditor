# 项目进度

## 当前状态
Phase 1-3 全部完成，Phase 4 的 4.1-4.4 完成。剩余 Step 4.5（MODULE_7 端到端验证），等待用户提供真实文档。

## 当前任务
**Step 4.5: MODULE_7 端到端验证**
- 类型：端到端验证
- 来源：feature_list.json Step 4.5
- 目标：用真实 MODULE_7 剧本走通完整流程
- 进展：已创建简化版 fixture 占位，等待用户复制真实 MODULE_7 文档

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

## 遗留问题 / 待讨论
- [ ] Step 4.5 等待真实 MODULE_7 文档进行端到端验证
- [ ] 编辑器"/"菜单工具引用的渲染优化（当前为纯文本 {{tool:xxx}}）
