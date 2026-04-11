# 项目进度

## 当前状态
v2.5 会话持久化 + Langfuse 可观测性已上线。v2.6 剧本版本管理 + 编辑器试玩走后端开发中——为了消除"编辑器试玩无 trace"、"剧本无历史版本"、"playthrough 引用会被剧本改版意外破坏"三个问题，做一次破坏性迁移引入 scripts + script_versions 双表结构。

## 当前任务
**v2.6 剧本版本管理 + 编辑器试玩走后端（拆为 6.1-6.6 六个 feature 逐个推进）**
- 类型：重构 + 新功能 + 破坏性迁移
- 来源：本轮讨论（见"v2.6 剧本版本管理"设计决策段）
- 目标：后端统一存剧本 + 引入版本概念，编辑器试玩走后端便于排查

### 推进顺序（逐个 feature 串行，上一个 verify 通过再开下一个）

1. **6.1 schema 迁移**（破坏性）—— 先定型数据层
2. **6.2 后端路由** —— 有了 schema 填实现 + 删 scriptStore
3. **6.3 前端编辑器适配** —— 保存/加载/版本列表走后端
4. **6.4 编辑器试玩走后端** —— PlayPanel 改 editorMode + Langfuse 覆盖编剧试玩
5. **6.5 玩家侧适配** —— 首页 + 游玩记录按新路径
6. **6.6 前端 IndexedDB 下线（可选）** —— 全稳定后再做

### 6.1 改动设计（下一个动手的）

**目标**：建立新的 schema，破坏性清空旧 playthroughs。

**新 schema**：

```sql
CREATE TABLE scripts (
  id text PRIMARY KEY,
  author_user_id text NOT NULL REFERENCES users(id),
  label text NOT NULL,
  description text,
  created_at timestamptz DEFAULT NOW() NOT NULL,
  updated_at timestamptz DEFAULT NOW() NOT NULL
);

CREATE TABLE script_versions (
  id text PRIMARY KEY,
  script_id text NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  version_number integer NOT NULL,        -- 机器排序
  label text,                             -- 人看的可选文本
  status text NOT NULL,                   -- 'draft' | 'published' | 'archived'
  manifest jsonb NOT NULL,
  content_hash text NOT NULL,             -- sha256(manifest) 去重
  note text,
  created_at timestamptz DEFAULT NOW() NOT NULL,
  published_at timestamptz,
  archived_at timestamptz,
  UNIQUE (script_id, version_number)
);

CREATE UNIQUE INDEX idx_one_published_per_script
  ON script_versions(script_id) WHERE status = 'published';

-- playthroughs 破坏性重建
DROP TABLE playthroughs;
CREATE TABLE playthroughs (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  script_version_id text NOT NULL REFERENCES script_versions(id),
  kind text NOT NULL,                     -- 'production' | 'playtest'
  ... (其他字段保留原结构)
);
```

**文件改动清单**：
- 修改 `server/src/db/schema.ts` — 新增 scripts / script_versions 表定义，playthroughs 改字段
- 新增 Drizzle migration — drop playthroughs 并重建 + 建新表
- 修改 `src/core/types.ts` — 删除 ScriptManifest.version 字段
- 修改 `src/ui/editor/EditorPage.tsx` + `ScriptInfoPanel.tsx` — 移除前端 version 引用（只是编译通过即可，后续 6.3 再改 UI）
- 修改 `src/fixtures/module7-test.ts` — 移除 version 字段

## 已完成的里程碑

### v2.5 会话持久化 + Langfuse 可观测性（2026-04）
- Drizzle + PostgreSQL 接入，playthroughs 表完成持久化
- GameSession 通过可选 SessionPersistence 接口在关键节点写 DB
- WebSocket 推流 + 断线重连 + restore 完整链路
- 匿名 sessionId → userId 映射，player identity 混合方案 Plan 4
- Langfuse 自部署 docker-compose，trace 覆盖 generate / tool span / player_input events
- agentic loop 多 step tracing（每个 step 一条 llm-step-N generation span）
- partKinds 标记 narrative / tool-only 步
- 上线正在运行，但编辑器试玩不在 trace 内（触发 v2.6 改造）

### 引擎知识单一真源重构（2026-04-11）
- 抽出 `src/core/tool-catalog.ts` 作为工具元数据单一真源（name/description/uiLabel/required）
- 抽出 `src/core/engine-rules.ts` 作为运行时规则 + 编剧改写规范单一真源
- 修掉 5 处硬编码漂移：PromptPreviewPanel 的旧版 ENGINE RULES（真 bug）、VIRTUAL_IDS 重复、INTERNAL_STATE 格式不一致、ScriptInfoPanel 缺 3 个可选工具、completion-sources 有 2 个幻觉工具（play_sfx / roll_dice）
- 修掉 signal_input_needed prompt 矛盾（轻路径 vs 硬性调用）
- 修掉 AI 改写 maxOutputTokens 缺失导致的中途截断

### UI 路由重构（2026-03-31）
- 新增 Zustand 状态路由（app-store.ts）
- 首页 HomePage + ScriptCard 卡片网格
- 对话页 PlayPage（从 App.tsx 抽取）+ openingMessages 静态开场
- 脚本注册表 registry.ts
- App.tsx 改为路由分发器
- ScriptManifest 新增展示字段（coverImage/description/author/tags/openingMessages）
- ScriptCatalogEntry 轻量目录类型

### 代码修正计划（2026-03-31）
- 10 步完成：types 重写 → flow-executor 删除 → game-session 重写 → store/UI 更新 → 全量验证
- fixture 改为加载原始编剧文档（Vite ?raw import）
- initialPrompt 支持（prompt.txt 作为首轮 user message）

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
| 2026-04-03 | signal_input_needed 从终止工具改为挂起模式 | 终止工具违反 LLM tool calling 认知模型，导致参数丢失和 context 断裂 | 重写 llm-client/tool-executor/game-session 核心循环 |
| 2026-03-31 | 重写 v2.0.md，删除 FlowExecutor 节点驱动设计 | 实现偏离了设计讨论决策 | 核心循环改为 Generate + Receive，FlowGraph 降级为可视化参考图 |
| 2026-03-31 | 引擎层术语中性化：GM/PC → Generate/Receive | 引擎不应绑定特定交互模式 | 记忆条目 role 改为 'generate'/'receive' |
| 2026-03-31 | UI 路由用 Zustand 状态路由，不引入 React Router | 项目只有 3 页，状态路由最轻量 | 新增 app-store.ts |
| 2026-03-31 | ScriptManifest 新增 openingMessages 字段 | 进入对话页后先展示静态开场（不经过 LLM），与 initialPrompt（LLM 首轮指令）职责分离 | PlayPage 在 session start 前插入静态消息 |
| 2026-03-31 | 编辑器选用 CodeMirror 6 而非 Monaco | 包体积小（~150KB vs ~2MB+），自定义语法/补全简单，适合 Markdown + 少量自定义标记 | 需安装 @codemirror 系列依赖 |

## 遗留问题 / 待讨论
- [ ] 编辑器"/"菜单工具引用的渲染优化（当前为纯文本 {{tool:xxx}}）
- [ ] Architect Agent pipeline 尚未与 UI 端到端连接（当前 e2e 使用手写 IR fixture）
- [ ] 存档读档功能已实现但未在 e2e 中验证（需 UI 入口）
- [ ] 首页卡片封面图暂为占位，需要实际资源或生成方案

---

## 重要设计决策讨论记录

### signal_input_needed 架构重构：从终止工具改为挂起模式（2026-04-03）

**背景**：signal_input_needed 最初设计为"终止工具"——不提供 execute，SDK 通过 hasToolCall stopWhen 强制截断 agentic loop。实测发现两个问题：(1) LLM 调用终止工具时不传 optional 参数（DeepSeek 表现为 choices 始终为空）；(2) 从 LLM 认知角度看，"调了工具但永远拿不到结果"违反 tool calling 的标准流程。

**决策**：改为"挂起模式"——signal_input_needed 有正常的 execute，execute 返回一个挂起的 Promise，等玩家输入后 resolve，玩家的选择作为 tool result 返回给 LLM。LLM 拿到结果后继续生成叙事，最终自然停止。

**核心论证——两个循环的 Claude Code 类比**：

游戏引擎的交互模型与 Claude Code 完全同构：

- **内循环（agentic loop，一次 generate() 内）**：LLM 可以多次调工具（查记忆、读状态、更新状态），中途通过 signal_input_needed 等待玩家输入（等价于 Claude Code 的 AskUserQuestion），拿到结果后继续生成。一次 generate() 内可能有 0 次、1 次或多次玩家互动。

- **外循环（generate() 之间）**：generate() 返回后，引擎执行记忆压缩、状态序列化、重建 system prompt，然后开始下一次 generate()。等价于 Claude Code 完成一整套操作后停下来等用户下一条指令。

```
┌─── 外循环（玩家视角的"一轮"）──────────────────────────┐
│  generate() 开始                                        │
│  ┌─── 内循环（agentic loop）──────────────────────┐    │
│  │  Step 1: query_memory + read_state → 结果      │    │
│  │  Step 2: 生成叙事 + signal_input_needed(choices)│    │
│  │          + update_state                         │    │
│  │          → update_state 立刻返回                 │    │
│  │          → signal_input_needed 挂起 ← 玩家互动   │    │
│  │          → 玩家选了 → resolve                    │    │
│  │  Step 3: LLM 拿到结果，继续叙事，自然停止        │    │
│  └─────────────────────────────────────────────────┘    │
│  generate() 返回 ← 一轮结束                             │
│  外循环：记忆压缩、重建 system prompt                    │
│  → 下一次 generate()                                    │
└─────────────────────────────────────────────────────────┘
```

**关键结论**：不管 LLM 调不调工具，挂起模式都完全符合 LLM 的认知模型：
- 不调工具：生成文本，自然停（finishReason: 'stop'）
- 调了工具：等结果，拿到结果继续生成，直到自然停或再次调工具

**旧方案的问题**：
1. LLM 调了 signal_input_needed 但永远拿不到结果（工具调用凭空消失）
2. 玩家输入以 user message 传入，但 LLM 期望的是 tool result
3. 同一 step 里其他工具的结果可能被截断吞掉
4. 每轮 context 是断裂重建的，LLM 没有推理连续性

**影响范围**：llm-client.ts（去掉 stopWhen/hasToolCall，signal_input_needed 改为正常 execute）、tool-executor.ts（execute 改为返回挂起 Promise）、game-session.ts（外循环适配）、game-store.ts（UI 状态适配）
