# 项目进度

## 当前状态
声明式视觉 IR Step V.3（System prompt v2 + few-shot + 白名单插值）完成并过绿。frontend tsc 0 error，frontend core tests 233/233 全绿（含 12 个新增 engine-rules 测试），server tests 141/141 全绿，bun start 启动干净。`buildEngineRules({protocolVersion, characters, backgrounds})` 工厂产出按版本分叉的引擎规则；v2 剧本 prompt 里直接嵌入 manifest 白名单 + 硬性"非白名单 NPC 转写到 `<narration>`"条款（RFC §12.1.1 Shape C 补丁）+ 8 单元 few-shot；v1 字节回归保 prompt cache 不破。存量剧本 protocolVersion 缺省 v1，零行为变化。下一步：本地连 ivn-test 验证后再决定 rollout；V.4（runtime 视觉 patch emission）继续推。

## 当前任务
**（空闲）V.3 done。本地连 ivn-test 跑一轮验证后再决定是否 rollout；不 push 远端。**

## 最近完成
**V.3 System prompt v2 + 白名单插值（2026-04-24）**
- `src/core/engine-rules.ts` 重写：拆 `RULES_PROLOGUE` / `NARRATIVE_FORMAT_V1` | `buildNarrativeFormatV2(chars,bgs)` / `RULES_EPILOGUE` 三段，导出 `buildEngineRules({protocolVersion, characters, backgrounds})` 工厂。v1/v2 共享 prologue + epilogue **字节级一致**（prompt cache 命中不破）。
- v2 prompt 覆盖：顶层三容器（`<dialogue>` / `<narration>` / `<scratch>`）语义 + 属性、视觉子标签（`<background/>` / `<sprite/>` / `<stage/>`）、四条视觉继承规则、manifest 白名单动态插值（空数组 → "（剧本未定义任何 X）" 兜底）、RFC §12.1.1 硬性条款**"非白名单角色转写到 `<narration>`"**、禁用 change_scene/change_sprite/clear_stage 工具、输出预算救场、8 单元 few-shot 示例。
- `src/core/types.ts`：`ProtocolVersion` 类型从 game-session.ts 挪到这里（纯类型层，engine-rules / schemas 可引，不形成 runtime 模块循环）。
- `src/core/context-assembler.ts`：`AssembleOptions` 扩 `protocolVersion` / `characters` / `backgrounds` 三字段；`VIRTUAL_IDS.RULES` 从静态 `ENGINE_RULES_CONTENT` 改走 `buildEngineRules(...)`。
- `src/core/game-session.ts`：`GameSessionConfig` / `RestoreConfig` + 类 private 字段增 `characters` / `backgrounds`；`runAssemble` 透传至 `assembleContext`。
- `server/src/session-manager.ts`：`buildConfig()` + `restoreConfig` 从 `manifest.characters` / `manifest.backgrounds` 直接透传（v1 下也传不影响，prompt 层按版本决定是否读）。
- `src/ui/editor/PromptPreviewPanel.tsx` + `src/ui/editor/EditorPage.tsx`：新增 `protocolVersion` / `characters` / `backgrounds` props 链路；EditorPage 新增 `protocolVersion` state 从 `manifest.protocolVersion` 回填 + 保存时仅非 v1 写入（保持老剧本 manifest 干净）。
- `ENGINE_RULES_CONTENT` 导出保留作 `buildEngineRules('v1-tool-call')` 的 alias，编辑器 AI 改写等 legacy 消费者无需迁移。
- **12 个新单测**（`src/core/__tests__/engine-rules.test.ts`）：v1 字节回归（缺省 / 显式 v1 都等于 `ENGINE_RULES_CONTENT`）、v1 保留老 `<d>` XML-lite 标志、v1/v2 前 500 字符共享前缀、v2 空白名单兜底文案、v2 非空白名单插值 char/mood/bg id、v2 sprites 空的 character 单独兜底、v2 必须含 NPC 转写规则 + 禁用 v1 工具 + `<scratch>` 解释 + 继承规则四条、v2 白名单变化非 no-op（alice vs bob）。
- 验证：`bunx tsc --noEmit` 前端干净；`bun test src/core` 233/233（老 221 + 12 新）；`cd server && bun test` 141/141；`cd server && bun start` migration + Langfuse/DB 连接 + 监听 3001 全干净。

**V.2 Session 层接线 + 视觉继承（2026-04-24）**
- `ScriptManifest` 新增可选字段 `protocolVersion: 'v1-tool-call' | 'v2-declarative-visual'`（缺省 v1）
- `GameSessionConfig` / `RestoreConfig` 增 `protocolVersion` + `parserManifest` 两入参；v2 path 要求同时提供 parserManifest（否则构造期抛）
- `GameSession.generate()` 按 protocolVersion 分叉 parser：
  - v1 → 原 `NarrativeParser` + `createNarrationAccumulator`
  - v2 → `createParser(v2)` + `drainBatch({ sentences, scratches, degrades })`
    - sentences 透传给 emitter，this.currentScene 从 `sentence.sceneRef` 复制（parser 内部已 resolve 继承）
    - narration/dialogue truncated 继续走 narrative-truncation 事件
    - `<scratch>` batch 聚合 emit `ir-scratch { count, totalChars }` 事件（非 degrade）
    - 每条 degrade emit `ir-degrade:{code}` 独立事件
  - 共享 closure：`feedTextChunk` / `finalizeParser` / `flushPendingNarration`
- v2 path `scenePatchEmitter = null`（RFC §6：v2 不再发 scene-change WS 事件）；v1 path 保留原包装
- ScratchBlock 无需特殊路由：`<scratch>...</scratch>` 原文已由 `onTextChunk` 进 `currentNarrativeBuffer` → 入 narrative_entries → 下一轮 messages-builder 自然 replay 到 assistant 历史
- server `session-manager.buildConfig()`：按 `manifest.protocolVersion` 分叉；v2 用 `buildParserManifest(manifest)` 生成白名单；restoreConfig 同步带上避免重连后 parser 选型跳变
- 验证：frontend tsc 干净、server tests 141/141、frontend core tests 221/221（含 V.1 的 73 parser v2）、bun start migration + Langfuse/DB 干净

**V.1 parser 重写（2026-04-24）**
- RFC 收尾：§2 加原则 #6 #7、§3.1 加 `<scratch>`、§7 加 scratch 出口 + few-shot、§10.1 加 ir-scratch、§11 V.1 加 FP 约束
- 新目录 `src/core/narrative-parser-v2/` 5 个文件：tag-schema（声明式 schema 表）→ state（纯数据 + 栈助手）→ inheritance（纯函数视觉推导）→ reducer（`(state, event) → { state, outputs }`）→ index（htmlparser2 组合层 + `buildParserManifest` helper）
- Sentence 扩展可选 bgChanged/spritesChanged/truncated；新类型 ScratchBlock（text/turnNumber/index）
- 73 单测：inheritance 12 + reducer 30 + parser 31（含 chunk size 1/2/3/5/7/13/50/1000 参数化测试 chunk 边界重组）
- v1 parser 34 测试保留不动，并存设计零改 game-session
- 实现期修 bug：finalize 必须先 dispatch `finalize` event、再 htmlParser.end()。反序会让 htmlparser2 合成 closetag 先 pop 栈，丢失 truncated 标记。

---

## 已完成的里程碑

### v29 三 bug 合修 rollout（2026-04-24）

- **Bug A**（读档后前端 history 乱）：`recordPendingSignal` 在写 signal_input 之前
  先把 `currentNarrativeBuffer` flush 到 memory + DB。narrative_entries 的
  `orderIdx` 顺序现在和玩家直播顺序一致（narrative → signal_input → player_input），
  restore 回放给前端时不再把选项塞到对应旁白之前。
- **Bug B**（`currentStepBatchId` 更新太晚）：`LLMClient.generate` 加 `onStepStart`
  回调，在 `experimental_onStepStart` 内把新 batchId 回传给调用方；game-session
  立刻更新 `this.currentStepBatchId`，同 step 内 `tool.execute` 读到的永远是当前
  step 的 batchId。原先只在 `onStep`（= finish）里写，导致 mid-step 的
  `recordPendingSignal` 读到上一 step 的或 null。
- **Bug C**（restore 50 条截断）：后端新增 `GET /api/playthroughs/:id/entries?offset&limit`
  轻量分页端点；前端 `ws-client-emitter.case 'restored'` 在 `msg.hasMore=true`
  时循环 HTTP fetchMore 到全部加载完，再 `setVisibleSentenceIndex` 到末尾。
  长 playthrough 读档后整个 backlog 完整可见。
- **Bonus**：`tracing.recordStep` 加 `isFollowup` metadata + Langfuse generation
  name 加 `-followup` 后缀，事后按这个维度筛 trace 直接可用。

代码改动文件：llm-client.ts（+onStepStart）、game-session.ts（wire + currentTurn + pre-flush）、playthrough-service.ts（+countEntries）、playthroughs.ts route（+GET entries 分页）、ws-client-emitter.ts（+fetchMore loop）、tracing.ts（+isFollowup 字段）。

### M4：资产上传 pipeline（2026-04-21）
- **后端** (commit feat(m4a))
  - migration 0008 `script_assets` 表（FK scripts ON DELETE CASCADE）
  - `AssetStorage` S3 抽象（AWS SDK v3 + lib-storage Upload 流式分片）
  - `asset-service.ts` CRUD + `assets.ts` 四个 routes（POST/GET list/GET read/DELETE）
  - 不做 mime/size 白名单（决策 Q5：不限制）
  - 本地 dev：`ops/minio/docker-compose.yml`（含 minio-init 自动建 bucket）
  - `server/.env.example` 加 S3 配置
- **前端** (commit feat(m4b))
  - `useAssetUpload` hook (multipart POST)
  - ScriptInfoPanel SpritesEditor：40×40 缩略图 + "传/换" 按钮（scriptId 为 null 时 disabled）
  - ScriptInfoPanel BackgroundsSection：64×40 缩略图 + "传/换" 按钮
  - DefaultSceneSection：160×96 预览，背景 + 立绘按 position 叠加
  - M1 SceneBackground / SpriteLayer：assetUrl 真图渲染 + onError 回落占位
- Plan / 决策表见 `.claude/plans/m4-asset-pipeline.md`

### M1 + M2：VN 播放与资产编辑（2026-04-21）
- **M1** 玩家侧 VN 渲染层（commits 00edf2c / ed9c41f）
  - 三层组件（SceneBackground / SpriteLayer / DialogBox）+ VNStage / VNStageContainer
  - click-to-advance 推进模型；scene_change 自动跳过（对话框不占用）
  - openingMessages 前置合成为 synthetic narration Sentence（index 负数）
  - Sentence 级打字机（RAF 驱动，cps 可调，click 跳到末尾）
  - scene-change 过渡动效（fade / cut / dissolve；背景 crossfade + 立绘 fade-in）
  - Backlog 右侧 drawer 只读回看
  - PublicScriptInfo 透传 characters / backgrounds / defaultScene，speaker 正确显示"咲夜"而非 sakuya
  - WS 'reset' 消息保留 VN 字段（防止 game-session.start 清掉 seedOpeningSentences 的产物）
  - 删老 NarrativeView (558 行) + DebugPanel；entries 相关 store 字段全部移除
  - EditorDebugPanel 加 "Raw" tab 看原始 XML-lite 流（老视图下线补偿）
  - raw-streaming-store 独立小仓库承接 text-chunk（不再污染 game-store）
- **M2** 编辑器侧 VN 资产管理（commit 978420d）
  - ScriptInfoPanel 新增三个 section：角色 / 背景 / 默认场景
  - CharactersSection：行展开编辑 displayName + SpritesEditor（id + 可选 label）
  - BackgroundsSection：id + label 行 + 新建 + 删除
  - DefaultSceneSection：背景下拉 + 可选开场立绘（角色 / 表情 / 位置）
  - snake_case id 校验（`^[a-z][a-z0-9_]*$`）+ 不重复 + inline error
  - EditorPage manifest state 扩展 + load/save 链路接入
  - 明确不做文件上传（等 M4 OSS pipeline）
- Preview 端到端验证过，tsc clean，server tests 95/95

### M3：视觉层铺底 XML-lite 协议 + 场景状态（2026-04-20）
- 新增 SceneState / ParticipationFrame / Sentence 类型
- NarrativeParser 流式状态机 + 27 单测（含末尾未闭合 `<d>` 自动 close 标 truncated）
- game-session 挂 parser，applyScenePatch 统一走 WS 推流
- 工具集：移除 show_image，加入 change_scene / change_sprite / clear_stage
- migration 0007：playthroughs.current_scene (jsonb) + sentence_index (integer)
- 基础设施：DB SSL 弹性配置（PG_SSL env）、connectionTimeout 放宽到 15s、.claude/launch.json 加 server 配置
- P2b 回退：撤销"admin 不能创 production playthrough"的 403 限制
- 两次 commit：1538fb5 feat(m3) / d9cfde1 fix(playthroughs)

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
| 2026-04-12 | IndexedDB 下线不做一键上传，走"强制导出备份+清理"流程 | 自动上传会在多设备/重名/孤儿 id 场景产生静默覆盖；备份+手动 import 更安全 | LocalBackupGate 作为过渡期 modal，检测到遗留数据时阻塞编辑器，逼用户先导 json 再清 IDB |
| 2026-04-12 | LLM 配置每剧本独立 + playthrough 创建时固化 + fallback 链 | 多 admin 共用时每人可能要不同模型；production / 试玩独立；老 playthrough 不被 config 变更波及 | scripts 加 production_llm_config_id，playthroughs 加 llm_config_id NOT NULL；body.llmConfigId > script.productionLlmConfigId > 最早 config 兜底；编辑器 playtest dropdown 存 localStorage |
| 2026-04-12 | AI 改写遇 length 截断自动续写，最多 8 段 | 长剧本 prompt 超 8192 tokens 是常态，手动补齐低效 | 循环 generate() 带 assistant history；UI 显示 "续写 N/8" 进度；derivedContent 每段 append |
| 2026-04-19 | M3 引入 XML-lite 叙事协议 + 场景状态持久化 | 原"整段文本"输出无法驱动立绘/背景/PF 分析；需要流式解析 + 细粒度事件 | 新增 NarrativeParser（27 单测）；game-session/emitter/store/DebugPanel 全链路适配；迁移 0007 加 current_scene/sentence_index；工具集替换 show_image → change_scene/change_sprite/clear_stage |
| 2026-04-19 | 撤销 admin 不能创 production playthrough 的限制 | kind + role_id 两维已够分析时过滤；硬门挡住 admin 自己走玩家流测试 | `server/src/routes/playthroughs.ts` POST 删掉 403 分支，注释明确记录"曾短暂限制过，已撤销" |
| 2026-04-21 | M1 推进模型 click-to-advance + 只做 manual | VN 体感；auto/skip 配合 save/load 才有意义，当前没有 | 暂不做 auto/skip，未来需要时再加 playMode state |
| 2026-04-21 | M1 advance 自动跳 scene_change Sentence | scene_change 只驱动视觉切换，占 click 会让玩家看空白对话框 | `advanceSentence` / `appendSentence` 初始化都跳过 scene_change kind |
| 2026-04-21 | WS 'reset' 消息不全量 reset 客户端 store | game-session.start() 会发 'reset'，但客户端 seedOpeningSentences 已经在 mount 时填了 parsedSentences，全量 reset 会清掉 | `'reset'` handler 改为只清 status / error / inputHint / inputType；VN 字段（parsedSentences / currentScene / visibleSentenceIndex）保留 |
| 2026-04-21 | M1 choices 与对话并存时允许 advance | 玩家可能还没读完就触发了 signal_input_needed，应该能继续点看完再选 | click-to-advance 不因 isWaitingChoice 阻塞；advance 到末尾自然 no-op |
| 2026-04-21 | M2 不处理文件上传 | M4 专门做 OSS pipeline；M2 只存 id + label，assetUrl 留空 | SceneBackground / SpriteLayer 对空 URL 已有占位渲染，M4 填 URL 后无需改 UI |
| 2026-04-24 | signal_input_needed 空停改为 llm-client post-step 补刀，不动 prompt 也不挪到 game-session | 主 generate 漏叫是 provider 级问题（prompt 已足够明确），解决要走协议级 toolChoice；放在 llm-client 让主 / 补刀共享 callbacks + closure，调用方无感 | StepInfo 加 isFollowup 字段；game-session onStep 回调的 currentStepBatchId 更新门控 !step.isFollowup；narrative + signal_input 共享 batchId 反而比多步主生成时更整洁 |
| 2026-04-24 | 声明式视觉 IR 采用嵌套 XML 子标签（`<dialogue>`/`<narration>` + 子 `<background/>`/`<sprite/>`/`<stage/>`），替代 change_scene/change_sprite/clear_stage 工具；manifest 加 protocolVersion="v2"，v1/v2 并存 | N=30 实测方案 B（紧凑 DSL）四项通过率只有 63%，Shape C 30%；方案 C（嵌套 XML 全名）87% / Shape C 70%，且 mc-as-sprite / `?` 占位符 / DSL 语法错全部归零。XML 贴近 LLM 训练分布 + Anthropic 官方推荐 + TEI/articy prior art 同构 | RFC-声明式视觉IR_2026-04-24.md；新 Sentence 字段 bg/sprites/bgChanged/spritesChanged；视觉状态继承为默认，显式为例外；parser 换 htmlparser2 + FP reducer（§11 Step V.1~V.7） |
| 2026-04-24 | 新增 `<scratch>` 顶层容器 + §2 设计原则 #6（为"非目标输出"提供合法分类出口，而非 prompt 禁令） | Langfuse trace 显示 LLM 会在叙事里泄漏"让我先读取 state..."等元叙述，污染 `<narration>`；prohibition 经验上服从率低；Anthropic 官方推荐结构化 `<thinking>` 模式（`<scratch>` 避开 DeepSeek-R1 `<think>` 冲突） | `<scratch>` 不产出 Sentence、不渲染、保留给下一轮 messages；tracing 单独事件 `ir-scratch`（非 degrade，用于量化元叙述转移率） |
| 2026-04-24 | Parser v2 全面采用函数式 / 组合式 / 声明式（§2 原则 #7） | 原 parser.ts 350 行手搓状态机难以扩展新 tag（需同步改 enum + switch + 字段）；声明式 schema + 纯 reducer 让加一个 tag 只需追加一行 schema 条目 | parser 层禁 class、禁顶层可变 let；state/reducer/inheritance/tag-schema 模块化；mutation 仅限 htmlparser2 回调边界 |
| 2026-03-31 | 重写 v2.0.md，删除 FlowExecutor 节点驱动设计 | 实现偏离了设计讨论决策 | 核心循环改为 Generate + Receive，FlowGraph 降级为可视化参考图 |
| 2026-03-31 | 引擎层术语中性化：GM/PC → Generate/Receive | 引擎不应绑定特定交互模式 | 记忆条目 role 改为 'generate'/'receive' |
| 2026-03-31 | UI 路由用 Zustand 状态路由，不引入 React Router | 项目只有 3 页，状态路由最轻量 | 新增 app-store.ts |
| 2026-03-31 | ScriptManifest 新增 openingMessages 字段 | 进入对话页后先展示静态开场（不经过 LLM），与 initialPrompt（LLM 首轮指令）职责分离 | PlayPage 在 session start 前插入静态消息 |
| 2026-03-31 | 编辑器选用 CodeMirror 6 而非 Monaco | 包体积小（~150KB vs ~2MB+），自定义语法/补全简单，适合 Markdown + 少量自定义标记 | 需安装 @codemirror 系列依赖 |

## 遗留问题 / 待讨论
- [x] ~~编辑器"/"菜单工具引用的渲染优化（当前为纯文本 {{tool:xxx}}）~~ v2.7 下线，改为直接写工具裸名
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
