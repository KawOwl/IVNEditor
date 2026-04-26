# 项目进度

## 当前状态

**两条平行工作线**：

1. **V.x 声明式视觉 IR（product feature）**：V.1 - V.7 全部完成并过绿。frontend tsc 0 error，frontend core + stores tests 248/248 全绿，server tests 181/181 全绿（注：181 = 141 v2 IR 完成时基线 + 40 op-kit 迁移期增量）。v2 IR 从 parser / system prompt / session 接线 / 前端消费 / 续写 / tracing / 编辑器协议切换已端到端打通。新建剧本默认 v2；老剧本载入保持 v1 不迁移。等本地连 ivn-test 跑一轮 E2E 验证后决定是否 rollout。
2. **OP.x op-kit 单源 Operation 层（platform refactor + 业务能力）**：OP.0 - OP.4 完成（14 个 MCP tool 全部从 routes/mcp.mts 迁到 op-kit；mcp.mts 1378 → 281 行）。OP.5 - OP.7 P0 lint 套件 plan 就绪未开工，详见 `docs/refactor/op-kit-roadmap.md` 和 `docs/refactor/op-a-extract-referenced-ids-plan.md`。

## 当前任务

**PFB.1 玩家游玩内问卷反馈：5 题问卷直接落库**（in-progress）
- 类型：实现（产品 feature，e2e）
- 来源：用户临时插入。原诉求是把玩家页右上角"反馈"按钮接入飞书表单（prefill playthrough_id / user_id），讨论中权衡 iframe vs 跳转 vs 自家落库后选 D = 自家 `feedback` 表
- 目标：5 题问卷 modal + POST /api/feedback 直接写自家 DB；规避 iframe（X-Frame-Options）+ 跳转新 tab（手机端切走 WS 大概率断 + 现状 onclose 不自动重连）双重风险
- 进展：选型已定 + main 同步完成（fast-forward 拉入 700addd `feat(mcp): add script.patch_manifest_structure op`）+ feature_list.json 加 PFB.1 entry。下一步：schema.mts 加 feedback 表 → drizzle-kit generate 0000 baseline 后第一条 migration → feedback-service + route → PlayPanel.tsx FeedbackModal 重写 → typecheck + tests + 浏览器 smoke

**OP.5 = Op A: `script.extract_referenced_ids`**（暂停，PFB.1 完了再回来）
- 类型：实现（op-kit 业务能力扩展）
- 来源：op-kit roadmap 下一批 P0 lint 套件首个
- 目标：补完"修复型 agent"工具链中的"知道剧本实际引用了什么"这块拼图，作为 OP.7 propose_manifest_alignment 的纯函数上游
- 进展：**plan 已就绪，未开工**。完整 plan + 恢复指令模板见 `docs/refactor/op-a-extract-referenced-ids-plan.md`（顶部"恢复上下文指令"段直接 copy 给新会话即可开工）

**辅助任务（待评估）**：V.x 这条线的"本地连 ivn-test 跑 E2E 验证"还没跑。是否在 OP.5 之前 / 之后 / 并行做，看用户指示。

## 最近完成

**Memorax HTTP adapter + parallel composite，接 production game session（2026-04-26，本会话）**
- 用户目标：把同事自部署的 Memorax 服务（http://47.99.179.197/，schema `0006_drop_default_user_id`）当成 IVN 玩家剧本的长期记忆 store；mem0 当 fallback 并行写。Memorax 暂时不太稳定，需要失败可观测。
- **Bootstrap**：跑 `/auth/register` → `/projects` → `/v1/api-keys`（user-facing endpoint，scopes `read+write`，**不是** master `/admin/keys`），把账号/项目/key 落到 `~/.config/ivn-editor/memorax-bootstrap.json`（mode 600），三个 env 追加到 `~/.config/ivn-editor/.env`：`MEMORAX_BASE_URL` / `MEMORAX_API_KEY` / `MEMORAX_APP_ID`。`pnpm setup:env` 已链到 apps/server。
- **MemoraxMemory** ([adapter.mts](packages/core/src/memory/memorax/adapter.mts) + [client.mts](packages/core/src/memory/memorax/client.mts) + [mapping.mts](packages/core/src/memory/memorax/mapping.mts))：mem0 同模型（远端语义检索 + 本地 recentEntries 短窗口）但用 Memorax 的多层 ID hierarchy。ID 映射决策（关键）：`user_id = scope.userId`（系统玩家 id，跨存档聚合用）/ `agent_id = scope.playthroughId`（按存档隔离）/ `app_id = options.appId ?? 'ivn-editor'` / `session_id` 跳过（Memorax 要求 UUID，playthroughId 已经做隔离不必再塞）。retrieve 强制带 `filters: {and: [{agent_id: {eq: playthroughId}}]}`，永远不串档；将来想做"全玩家跨存档"分析把 filter 去掉就行。`appendTurn` 走 `async_mode=true`（fire-and-forget，避免被 Memorax 5-30s 同步抽取阻塞游戏循环）；`pin` 走 `async_mode=false`（等服务端确认，不容忍丢失）。
- **失败语义**：MemoraxMemory.retrieve 内部 try/catch HTTP/网络错误，**不抛出**，返回 `{summary:'', meta:{error:'<reason>'}}` —— ParallelMemory 检 `meta.error` 决定 fallback。这样单独使用 MemoraxMemory（eval / 单 provider 模式）也不会炸 game-session。`MemoraxError` 类带 `status / reason / message` 三字段便于上层分类（`AUTH_INVALID_TOKEN` / `timeout` / `network-error` / ...）。
- **ParallelMemory** ([parallel/adapter.mts](packages/core/src/memory/parallel/adapter.mts))：写 (`appendTurn / pin / maybeCompact / reset`) 全 `Promise.allSettled` fan-out + per-child rejection log + 综合 entry 兜底；retrieve 按 children 顺序逐个尝试，第一个返回 `meta.error` 或抛错 → fall back 到下一个，全部失败返回 `meta.source='all-failed'`；`getRecentAsMessages` 走 `coreEventReader`（canonical chat 来源，不混 child 的 recentEntries）；snapshot/restore 按 child name 分发，missing name 安全跳过（兼容增减 child）。Factory `case 'parallel'` 默认 `children=['memorax','mem0']`（memorax-primary）；可通过 `providerOptions.children` 自定义。
- **接线**：`MemoryConfig.provider` union 加 `'memorax' | 'parallel'`；`CreateMemoryOptions` 加 `memoraxConfig?: {baseUrl, apiKey, appId?}`；`GameSessionConfig` / `RestoreConfig` 同步加该字段；`apps/server/src/session-manager.mts` 加 `buildMemoraxConfig()` helper 从 env 注入；`packages/specification/src/env.mts` 加三个 optional env。manifest 不动 —— 启用方式是把某剧本 `memoryConfig.provider` 改成 `'memorax'` / `'parallel'`，老剧本默认 legacy 不变。
- **e2e smoke** ([scripts/smoke-parallel-memory.mts](packages/core/scripts/smoke-parallel-memory.mts))：不调 LLM 但走 production 工厂路径。三 phase：(1) happy path —— 写 3 turn + 1 pin、retrieve 命中 `meta.source='memorax'`，5 条 fact 都被 Memorax 蒸馏出来（包括复合句拆成两条）；(2) fallback —— 故意把 memorax key 改坏，retrieve 看到 `AUTH_INVALID_TOKEN` → fall through 到 mem0、`meta.source='mem0'` + `meta.attempted` 带失败历史；(3) cloud check —— 直接 curl Memorax 后端确认 5 条 record 全标对 `agent_id=playthroughId`（per-playthrough filter 在服务端按预期生效）。本地用 `bun --env-file=apps/server/.env packages/core/scripts/smoke-parallel-memory.mts` 一条命令复现。
- **dreamy-germain ANN.1 协调**：那条线在做"记忆删除标注"，给每个 adapter 构造加可选 `deletionFilter` 末位参数 + 一层 `RetrievalLogger` wrapper。Memory interface 8 方法签名**没动** → 我的 MemoraxMemory + ParallelMemory 接口契约和它无冲突。MemoraxMemory 构造预留了 inline 类型的 `deletionFilter?` 槽位（`{listDeleted(): Promise<ReadonlySet<string>>}`），ANN.1 rebase 时把 inline type 换成 `import { MemoryDeletionFilter }` 即可；ParallelMemory 透传给 children 也是机械工。`noop/adapter.mts` 在 dreamy-germain 已被删，main 还有，那边 rebase 时按自己策略处理。
- **Memorax 没有 memory-delete API**（OpenAPI 全集只有 `/v1/memories/{add,search}`，仓库 `@router.delete` 零匹配）—— `MemoraxMemory.reset()` 只清本地 recentEntries，云端按 `agent_id` 永久保留；剧本重开换新 playthroughId → 新 agent_id → search filter 自然看不到老档，业务侧不破。已存到 memory（`memorax-no-memory-delete-api.md`）。
- 验证：`pnpm typecheck` 4 package + scripts 全绿；`pnpm test:core` 318/318（278 + 22 memorax + 18 parallel = +40）；e2e smoke 三 phase 全过（Memorax 云端 5 条 record 实测确认）。
- 4 commit 落 main：`c79f136` adapter / `12eb78b` parallel / `925bf07` smoke script / `c0b8d64` smoke 的 typecheck 修复。

**新增 op `script.patch_manifest_structure`（2026-04-26，本会话）**
- 起因：用户提 manifest 太大，agent 改结构字段时要把所有 segment.content 回传太重；问能不能加"只改结构字段、不动 segments"的接口
- 新 op：[apps/server/src/operations/script/patch-manifest-structure.mts](apps/server/src/operations/script/patch-manifest-structure.mts)
  - 5 个可选字段：`characters` / `backgrounds` / `stateSchema` / `memoryConfig` / `promptAssemblyOrder`；整体替换语义（不做 by-id upsert）；至少一个字段否则 INVALID_INPUT
  - 沿用 `replace_script_manifest` 的最少校验（`z.unknown()` + 浅形状判断），不深 zod 让 schema 自由演进
  - exec：`getBaselineVersion + cloneManifest` → `applyStructuralPatch` → `scriptVersionService.create(status:'draft')`；hash 去重沿用 service 默认
  - 纯 patch 逻辑 `applyStructuralPatch` 通过 `_internal` export 给单测
- 注册：[registry.mts](apps/server/src/operations/registry.mts) ALL_OPS 写 batch 段加一行
- 守门：[__tests__/patch-manifest-structure.test.mts](apps/server/src/operations/__tests__/patch-manifest-structure.test.mts) 21 用例，重点 invariant **chapters/segments 在任何 patch 路径下都不被改写**
- 验证：`pnpm typecheck` 4 个 package 全绿；`bun --env-file=.env.test test` 138/138（含新增 21）
- 范围决策：用户原话列了 4 字段（characters / backgrounds / stateSchema / promptAssemblyOrder），加 memoryConfig 因为和 stateSchema 同属"运行时结构"且体量小。**未包含** `enabledTools` / `disabledAssemblySections` / `defaultScene` / 展示元数据 —— 后续如有需求扩 `PATCHABLE_FIELDS` + 加分支即可（每字段独立 if 块互不影响）
- 未做：worktree 第一次开工漏跑 `pnpm setup:env`，已补；无需改 v2.0.md（这是 platform tooling 不是 product feature）

**Memory eval infra 全套（2026-04-26，本会话）**
- 用户目标：搭对比评测 noop / mem0 / DeepSeek thinking 模式的 harness
- 一波 13 commit 在 `claude/compassionate-goodall-1acdca` 上演化，最后做 clean replay 重新落到 main 上变成 1 个大 feat commit
- 加的东西：
  - **noop memory provider**（`packages/core/src/memory/noop/adapter.mts`）—— 评测零基线。retrieve 永远空 summary，但 getRecentAsMessages 仍走 CoreEventHistoryReader 投影 chat history（DeepSeek thinking + tool 协议要求）。factory 注册 `'noop'` case。+ 7 个单测
  - **PlayerSimulator**（`packages/core/src/evaluation/player-simulator.mts`）—— LLM-driven 模拟玩家。persona = `{goal, style?, llmConfig}`，每个 simulator 实例维护自己的 chat history。绕过 LLMClient.generate 直接用 AI SDK generateText（不需要 agentic loop / tool / signal_input follow-up）。+ 16 个单测
  - **Transcript renderer**（`packages/core/src/evaluation/transcript-renderer.mts`）—— `MemoryEvaluationReport` → markdown，每 variant 一段，turn 按 turnNumber 升序展开。LLM judge / 人读两用。+ 12 个单测
  - **harness 改造**：`PlayerSource` union（`scripted | simulated`），simulated 用 `createSimulator: () => PlayerSimulator` factory pattern（每 variant 一个 fresh instance，不跨 variant 累积 history）；移除两层 `createNoThinkingLLMConfig` 强制 wrap，让 caller 控制 thinking；加 per-variant + per-turn stderr 进度日志
  - **assembleContext 6 步 stepdown 重写**（`context-assembler.mts`）—— 主函数 199 行 → 9 行，每步顶层函数：computeBudget → filterActiveSegments → buildAllSections → decideAssemblyOrder → packSectionsIntoBudget → loadRecentHistory → toAssembledContext
  - **DeepSeek thinking follow-up 修复**（`llm-client.mts`）—— DeepSeek reasoner family 拒绝任何非默认 toolChoice（`{type:'tool', toolName:...}` 和 `'required'` 都 400）。thinking 模式下省略 toolChoice + 把 follow-up tools 缩到 `{signal_input_needed, end_scenario}`，靠 nudge prompt 引导。非 thinking 路径不变
  - **typed scenario + 多个 entry .mts**（`scripts/evals/`）：
    - `_helpers.mts` —— `requireEnv` / `readGMLLMConfig`（带 `LLM_THINKING=on/default/off` 解析）/ `readPlayerLLMConfig` / `writeReport` / `writeTranscript` / `summarizeReport` / `exitOnHarnessFailure`
    - `scenarios/silver-key.mts` —— silverKeyScenario / silverKeyMemoryConfig / silverKeyPersona（纯数据）
    - `silver-key-scripted.mts` —— scripted inputs，跑 noop/legacy/llm-summarizer 三 variant
    - `silver-key-simulator.mts` —— simulator 玩家，REPS env（默认 1）控制每 provider 跑几次，VARIANTS env（默认 noop,mem0）控制跑哪些 provider，OUTPUT env 控制输出路径
    - `extract-scenario.mts` —— 接 op-kit `script.get_full_manifest` HTTP，把 live manifest 渲染成 typed scenario .mts
    - `render-transcript.mts` —— 老 .json report 不重跑直接重渲 .md
  - **scripts/tsconfig.json** —— extends parent + 加 bun types，让 `pnpm typecheck` 也覆盖 scripts/。`Bun.exit` 不在 @types/bun → 全切 `process.exit`
- 验证：`pnpm typecheck` 4 package + scripts 全绿；`pnpm test:core` 278/278；本地跑了一次 noop + thinking + 20 turn live eval，4 个 thinking-related bug 都修了，最终 20 turn 全 choice 模式无 API 错
- 已知遗留观察（noop baseline 的预期"病症"，留作 mem0 对比 baseline）：
  - 同一情节反复重置（开门事件在 turn 4-20 出现 7 次）
  - NPC 人物背景被现编多套不一致版本
  - 物品分裂（出现"另一把真正的银钥匙"）
- 未做（list 给下一会话）：mem0 对比跑、LLM judge 步骤（读 .md 出 issues JSON）、`update_state` 工具按 stateSchema 校验未声明字段

**V.9 dialogue speaker 立绘兜底（2026-04-26，本会话）**
- 起因：用户报 trace `784ab8fc-3915-47f0-b757-f7feae0604df`（ivn-engine）—— `<dialogue speaker="carina" to="player" mood="curious">` 没 `<sprite>` 子标签 + 上一句也没 carina，玩家屏幕看不到 carina 立绘。dialogue 上的 `mood="curious"` 是 silent tolerance 忽略（白名单只认 speaker/to/hear/eavesdroppers），不能靠它自动补 sprite。
- 触发条件（全部满足才补）：`<dialogue>` 关闭时 + speaker 是 manifest 已知角色 + speaker 不是 ad-hoc + manifest 给该角色配过至少一个 sprite + 当前 resolved sprites 不含 speaker 立绘 + 三个 position 至少一个空闲。
- 注入：speaker + manifest 默认 mood（sprites 数组第一个）+ 第一个空闲 position（依次试 center / left / right）。Position 优先顺序在 inheritance.mts 内单独定义（不复用 tag-schema.VALID_POSITIONS 的字母序），center 优先因为最贴单角色对话直觉。
- 三个位置全占满 → emit `<speaker>:no-position` 事件后跳过（不阻断生成，trace 能区分这种场景）。
- 改动：(1) [state.mts](packages/core/src/narrative-parser-v2/state.mts) ParserManifest 加 `defaultMoodByChar: ReadonlyMap<string, string>`；(2) [index.mts](packages/core/src/narrative-parser-v2/index.mts) buildParserManifest 填充该字段（sprites 数组第一个有效 id）；(3) [tag-schema.mts](packages/core/src/narrative-parser-v2/tag-schema.mts) DegradeCode 加 `dialogue-speaker-sprite-fallback`（同 V.8 pronoun degrade 同模式，挂在 degrades 通道但是中性事件）；(4) [inheritance.mts](packages/core/src/narrative-parser-v2/inheritance.mts) resolveScene 走完原 bg / sprite 解析后追加 `applySpeakerSpriteFallback` 一层（纯函数，输入 unit pf.speaker + manifest，输出 SpriteState[] + 可能的 degrade）。
- 守门：[inheritance.test.mts](packages/core/src/narrative-parser-v2/__tests__/inheritance.test.mts) 加 11 个兜底场景（空台 / prev 已含 / `<sprite>` 替换 / `<stage/>` 清场 / narration 跳过 / speakerMissing 跳过 / ad-hoc 跳过 / 杜撰跳过 / 没 sprite 配置跳过 / 三位全满 no-position）；[reducer.test.mts](packages/core/src/narrative-parser-v2/__tests__/reducer.test.mts) 加 trace 复现集成测；[parser.test.mts](packages/core/src/narrative-parser-v2/__tests__/parser.test.mts) buildParserManifest 加 defaultMoodByChar 断言 + character 无 sprites 边界。
- 验证：`pnpm typecheck` 4 个 package 全绿；`pnpm test:core` 323/323（从 308 涨 15）。
- 决策：触发条件用 "speaker 不在 resolved sprites"（更宽）而不是用户字面 "pendingSprites 为空"（更窄）。前者覆盖 `<stage/>` 清场后忘补 + LLM 只摆配角忘 speaker 两类额外 case；只字面看就只能修最浅一层。Prompt 不改——fallback 是纯协议层安全网，不能让 LLM 知道 / 偷懒。Ad-hoc 自动 skip（白名单外没 sprite 配置），不需要分流。

**修复 signal_input choices 泄漏到 LLM 上下文（2026-04-26，本会话）**
- 触发：用户报 trace `f6859a87`（session ece7e31d turn 5→6）。turn 5 LLM emit `signal_input_needed(choices=["我是路过的","我是被这根线拽过来的","你蹲在这里挺显眼","你应该问你自己是谁才对吧"])`，玩家走 freetext 答 `"哦，是人啊，还以为是哪里来的没见过的流浪猫呢..."`，turn 6 LLM 让夏荧说 `"你刚才不是说'被这根线拽过来的'吗"` —— 把 `choices[1]` 当成玩家发言。用户报"已经多次出现类似情况"。
- 根因：[messages-builder.mts](packages/core/src/messages-builder.mts:214) 投影 `signal_input` entry 时把 `choices` 数组完整塞进 assistant `tool-call.input`。AI SDK 序列化到 chat-completions 后 LLM 在自己上轮的 `tool_calls.arguments` JSON 里看到全部 4 条候选，玩家 freetext 时易把"摆桌上没被选的某条"当成玩家说过的话。系统性 leak，不是偶发。
- 修复：[messages-builder.mts](packages/core/src/messages-builder.mts:214) signal_input 分支的 `toolCallParts.input` 去掉 `choices`，只保留 `prompt_hint`（LLM 自己写的局面总结，不会被误读为玩家发言）。`readChoices` import 一并清理。persistence 层 / current-readback / UI restore / tracing 全不动 —— DB 里 `signal_input.payload.choices` 仍保留，只是不喂给 LLM 历史。
- 守门：[messages-builder.test.mts:7b](packages/core/src/__tests__/messages-builder.test.mts) 加回归用例：用 trace ece7e31d 的真实 4 条候选构造 signal_input，断言 ① `tool-call.input` 不含 `choices` key（不是空数组，是不存在）② 只有 `{prompt_hint}` ③ 整段序列化后任何一条候选字面量都不出现（防其他键名再次泄漏）。test 4 / A1 两条原断言更新为 `prompt_hint` only。
- 验证：`pnpm --filter @ivn/core test` 310/310 全绿（从 308 涨 2）；`pnpm typecheck` 4 个 package 全绿。
- 决策：选最小侵入修复（strip choices，留 prompt_hint）。tradeoff：LLM 失去"我上轮提了哪 4 个选项"的记忆 —— 这不是叙事推进所需信息，留着只会污染。如果将来发现真要 LLM 记得，可改成只回放"被选中的那条 + selectedIndex"，目前没必要。

**empty-narrative-turn 兜底 + prompt 硬规则（2026-04-26，本会话）**
- 触发：langfuse trace `8fe54eea-a39d-44a4-80d8-f34ef98cc440` —— LLM 整轮只输出 `<scratch>`，玩家屏幕一片空白。`<scratch>` 是元叙述容器（V.x 设计），不渲染玩家可见，所以 sentences=0 → UI 空白。
- 双层修复：
  1. **Prompt 层**（[engine-rules.mts](packages/core/src/engine-rules.mts)）输出纪律加硬规则"每轮回复必须至少包含一个 `<dialogue>` 或 `<narration>`"；反面示范加 ❌/✅ 一对（"整轮只 scratch = 玩家空白"）。
  2. **协议兜底层**（[llm-client.mts](packages/core/src/llm-client.mts)）在续写 follow-up 之后、signal_input follow-up 之前插入第三个 follow-up：检测 `fullText` 不含 `<(dialogue|narration)\b` 时重发一次 streamText，nudge 引导 LLM 补一段叙事。和续写同款（forward text-delta + 不强制 toolChoice + turnEndStop 允许自然 signal_input_needed 收尾），单次重试。根据 main 是否已调收尾工具调整 nudge 措辞避免重复调用；仍空时 console.warn。
- 顺序：`main → 续写 loop（length，最多 3）→ empty-narrative 补刀（无 narrative tag，1 次）→ signal 补刀（无收尾 tool，1 次）→ return`
- 守门：[engine-rules.test.mts](packages/core/src/__tests__/engine-rules.test.mts) 加 `v2 必须禁止整轮只输出 <scratch>` 三断言（硬规则文本 / 反面示范关键字 / 后果说明）。
- 验证：`bun test packages/core` 全绿；`tsc --noEmit` exit 0。
- 决策：选择"续写形态"而不是"signal 补刀形态"——前者转发 text-delta 让 parser-v2 渲染叙事，后者会吞掉 text 只为强制 tool_call。empty-narrative 的目的是把叙事补出来，必须转发；不强制 toolChoice 让 LLM 自由选择写完后是否调 signal_input_needed（turnEndStop 会接住）。

**V.8 声明式视觉 IR：dialogue 容器边界 + 代词 ad-hoc speaker degrade（2026-04-26，本会话）**
- 起因：用户审 trace（ivn-engine session c4b00c7c）怀疑 LLM 把第二人称代词"你"当成 NPC 写成 `__npc__你`，UI 因此渲染出名叫"你"的 NPC 气泡
- 根因诊断：prompt 里 `__npc__` 后缀模板 few-shot 全是中文显示名（`__npc__保安`/`__npc__同事`/`__npc__店主`），玩家自身 reserved id `player` 是英文裸字符串，模式不对称——LLM 顺着中文显示名的模式套出 `__npc__你` 是合理误用
- **Parser** [tag-schema.mts](packages/core/src/narrative-parser-v2/tag-schema.mts) + [reducer.mts](packages/core/src/narrative-parser-v2/reducer.mts:611)：加 `PRONOUN_DISPLAY_NAMES` ReadonlySet（10 个中文代词 / 泛称：你 / 我 / 他 / 她 / 它 / 他们 / 她们 / 咱 / 自己 / 主角）+ `isPronounSpeaker` helper；DegradeCode 加 `dialogue-pronoun-as-speaker`；reducer ad-hoc speaker 分支分流，pronoun 走新 degrade（**替代**而非追加 `dialogue-adhoc-speaker`，避免 trace 双计数）
- **Prompt v2** [engine-rules.mts](packages/core/src/engine-rules.mts)：(a) `__npc__` 章节加禁止条款明确列出 10 个代词 + 解释"你"是叙事代词不是 id；(b) 反面示范段加 `__npc__你` vs `to="player"` 正反例；(c) `<dialogue>` 容器解释加"正文只装直接引语，旁白 / 动作 / 第三人称描写必须走 `<narration>`"硬规则；(d) 反面示范段加用户 trace 原例"俄罗斯？...大拇指..."三单元拆分案例 + LLM 自检启发（"用角色声音念这段会不会别扭"）
- 测试：reducer 加 13 用例（10 个 pronoun it.each + 2 个 adhoc 边界 + 1 边界 invariants）；engine-rules 加 2 条 prompt 关键词校验；`pnpm test:core` 308/308（从 292 涨 16，含其他维护小项）；`pnpm typecheck` 4 个 package 全绿
- 后续待评估（**未做**）：把 `player` reserved id 包成 `__player__`（双下划线对称）+ manifest character.id 校验拒绝该 reserved id；等 trace 信号回来再决定。trace 端可 grep `dialogue-pronoun-as-speaker` 事件量化代词误用频率。

**LLM context 组装 + agentic loop 代码清理 round（2026-04-26，本会话）**
- 用户指令：审计 LLM 上下文组装链路 → 列清单 → 除 SceneState deep-readonly 之外都做
- 5 个独立 commit，每个改完跑 typecheck + test:core 验证再提交：
  - `4c4ded3` reuse evaluateCondition：`generate-turn-runtime.computeActiveSegmentIds` 抄了 `context-assembler.evaluateCondition` 的 `new Function` 整段，换成 import 复用 + 把 `stateStore.getAll()` 提出 filter 闭包（之前每个 segment 调一次）。-16/+5
  - `46e0acd` collapse section maps：`context-assembler` 的 `sectionContent: Map<string,string>` + `sectionTokens: Map<string,number>` 双 Map 合并成 `sections: Map<string, AssembledSection>`，category（'system'|'context'|'state'|'summary'）+ trimmable 在创建处一并定下；assembly 循环里那条 `if (id === VIRTUAL_IDS.STATE) ... else if (id === SCENE_CONTEXT) ...` 分类链塌成 `breakdown[section.category] += tokens`；干掉了 `activeSegments.find(s=>s.id===id)` 的 O(N) 查询。`tokenBreakdown` 字段名外部完全不变。-77/+67
  - `bd5684b` focus cache helper：`createPrepareStepSystem` 原来用 `JSON.stringify({scene,characters,stage})` 做 cache key + `JSON.parse(cachedKey)` 反序列化做 trace 日志；新增 `focusEquals(a,b)` 到 focus.mts 做结构相等比较，cache state 改为显式 `cachedFocus + everRefreshed` 布尔（之前用 `cachedSystemPrompt === context.systemPrompt` 对象身份判断）。+19/-12
  - `11b9c02` lift drainBatch：`createNarrativeRuntime` 里 55 行 closure 抽到顶层 `drainNarrativeBatch(batch, ctx)`，依赖通过 `DrainBatchContext` 显式声明（initialScene / publish / traceHandle / turnId / turn / getBatchId），不再 `this.*` 隐式捕获；scene 由函数返回让 caller 赋值给 `this.currentScene`。`createNarrativeRuntime` 70 行 → ~20 行。+110/-71
  - `7c970b1` llm-client 三循环统一：`generate()` 里 main / continuation / signal-input follow-up 三处 streamText 各自重抄 14 字段 + 重抄 fullStream drain + 重抄 usage merge → 抽 `baseStreamArgs`（共享 9 字段 + 4 hook）+ `consumeStream(stream, forward)` + `addUsage(stream)`（additive merge，主路径 prev=undefined 时等价于赋值）+ `turnEndStop`（main + continuation 共用）+ hoist `model = this.getModel()`。`generate()` ~525 行 → ~430 行（净 -44）。
- 验证：每个 commit 都跑 `pnpm --filter @ivn/core typecheck` + `pnpm test:core` 292/292；最后跑全量 `pnpm typecheck` 4 个 package 全绿
- 跳过项：用户明确说**不做** SceneState 冻 deep-readonly + 删 14 处 `copyScene()` 这条
- worktree 第一次开工：装 corepack@`~/.local/share/fnm/aliases/default/bin/corepack` + `corepack pnpm install` 把 5 个 workspace 的 deps 拉进来（worktree 不共享主 repo node_modules）

**EUX.1 编辑器试玩 tab 接入存档列表（2026-04-25，本会话）**
- 用户原话："在编剧的界面把存档列表也加上，让大家可以读取存档"
- 镜像玩家流 PlayPage 的 list-first 模式，把 EditorRightPanel 的'试玩'tab body 重做成"PlaythroughList ↔ PlayPanel"切换。
- **PlaythroughList.tsx**：加 `kind?: 'production'|'playtest'` prop，缺省 'production' 保留玩家流原行为；fetch URL 用 `kind` 变量代替硬编码。
- **PlayPanel.tsx**：重写 `handleStart` 里 `targetPtId` 决议——显式 `playthroughId`（非 'new'）两种模式都尊重，editorMode 只控制"缺省时"是否新建。原代码强制 `editorMode ? null : ...` 导致编辑器永远不能 reconnect 指定 playthrough（关键 bug 修复，否则存档列表点"继续"无效）。
- **EditorPlayTab.tsx**（新文件）：封装 list/play 状态机；header 始终显示 LLM dropdown，inGame 时多一个"← 返回列表"按钮；loadedScriptId=null 时显示占位文案。
- **EditorRightPanel.tsx**：play tab body 替换为 `<EditorPlayTab .../>`。
- 验证：`bun run typecheck` 干净；`bun test packages/core` 248/248 + `bun test apps/ui/src/core src/stores` 15/15 全绿；浏览器端到端跑通三场景（无 scriptId 占位 / 有 scriptId 列表 + 新建 / list ↔ play 切换 / "继续"按钮 reconnect 恢复 sprite + choices）。
- 决策记录：list 直接放进现有'试玩'tab 而非加新 tab——玩家流 PlayPage 也是 list-first，admin 心智一致；LLM dropdown 留 header（控制下一次 NEW playthrough 用哪套，reconnect 老的时已固化不影响）。

**op-kit 重构线 OP.0 - OP.4（2026-04-25）**
- **OP.0** `f843d61` op-kit 单源 Operation 定义 + 第一例 `script.lint_manifest`
  - 建 `apps/server/src/operations/`：`op-kit.mts`（`Op<I,O>` + `defineOp` + `runOp` + 8 条防腐契约）+ `errors.mts` + `context.mts` + `adapters/{http,mcp}.mts` + `registry.mts`
  - 首个 op `script.lint_manifest`：检查段落正文与 manifest 引用一致性（覆盖 undefined-bg/char/emotion + orphan + mixed-protocol，severity error/warning 二级）
  - 第一例就解决真实业务问题：trace `b45a0df9` 的 `bg-unknown-scene` degrade 根因诊断
- **OP.1** `eb60eaa` Batch 1：6 个 read MCP tool 迁移（list_scripts / list_versions / get_overview / get_segment / get_full_manifest / list_assets）；mcp.mts 1378 → 1119
- **OP.2** `65bfb20` Batch 2：3 个 write MCP tool（update_segment_content / replace_manifest / publish_version）；mcp.mts 1119 → 950
- **OP.3** `338ae1a` Batch 3：3 个 asset write MCP tool（upload_asset / add_background / add_character_sprite）；mcp.mts 950 → 386（最大瘦身，helper 一并搬走）
- **OP.4** `91aa9ce` Batch 4：destructive `delete_script` 迁移 + 14 个 op 全部完成；mcp.mts 386 → **281（纯 JSON-RPC 协议层，加新 MCP tool 不再碰）**
- 设计要点：`Op<I,O>` 类型不依赖 web 框架；HTTP / MCP / 将来的 OpenAPI / 前端 typed client 都从同一个 op 定义派生；`OpMeta.mcpName` 字段做 MCP 名 backward compat 让旧客户端配置无需改；防腐契约 8 条贴在 `op-kit.mts` 顶部
- 验证：apps/server 181/181 + packages/core 248/248 + tsc 干净；起 server smoke MCP `tools/list` 返回 14 tool 同名同形 + HTTP `GET /api/ops` 列出 14 op 含 effect: 'destructive' 标记 + delete_script dry-run / confirm 校验严格
- 详细报告：`docs/refactor/negentropy-2026-04-25-op-kit-bootstrap.md`（OP.0）+ `docs/refactor/negentropy-2026-04-25-mcp-tool-migration.md`（OP.1-OP.4 总览）+ `docs/refactor/op-kit-roadmap.md`（全貌 + 后续 OP.5-OP.10 路线）

**chore: setup:env 脚本（2026-04-25）**
- `cf3bbab` 加 `scripts/link-env.sh` + `pnpm setup:env`，把集中存放在 `~/.config/ivn-editor/{.env,.env.test}` 的真实 env 文件软链到 `apps/server/.env*`，幂等可反复跑
- CLAUDE.md 第三节顶部加"新 worktree 第一次开工：`pnpm install && pnpm setup:env`"

**V.7 ScriptInfoPanel 协议版本选择器（2026-04-24）**
- `ScriptInfoPanel`：基本信息段新增"叙事协议"dropdown，两选项 v2-declarative-visual（默认）/ v1-tool-call（老剧本）；选 v1 时显示黄色提示引导用 v2
- props 签名扩 `protocolVersion` / `onProtocolVersionChange`；EditorPage 透传现有 state
- `EditorPage.useState<ProtocolVersion>` 初值由 'v1-tool-call' 改为 'v2-declarative-visual'（新建 / 空编辑器默认）
- `handleNewScript` 显式 `setProtocolVersion('v2-declarative-visual')` —— 新剧本一律 v2
- 载入老剧本走 `manifest.protocolVersion ?? 'v1-tool-call'`（V.3 已铺），保存策略保留非 v1 才写入 manifest 不动 —— 老剧本零行为变化

**V.6 Tracing 事件（2026-04-24，复核完成）**
- 检查 game-session.ts drainBatch 已正确 emit：`scratches` batch 聚合成 `ir-scratch { count, totalChars }` 事件（非 degrade），每条 degrade 独立 emit `ir-degrade:${code}` 事件
- 验证 server `tracing.ts` event() 方法把这些传进 Langfuse trace.event，事后 UI 可按名称筛选
- RFC V.6 要求的"parser 暴露 degrade events, game-session 翻译成 tracing tag"完整闭环，V.2 落地时已顺带做掉，此步只做复核 + 文档

**V.5 续写 follow-up（2026-04-24）**
- `llm-client.ts` 在主 generate 完成、signal_input follow-up 之前插入一段**续写 follow-up 循环**：`finishReason === 'length'` 且非 abort 时最多续写 3 次（`MAX_CONTINUATION_ATTEMPTS`）
- 每次续写：把累积 `fullText` 作为 assistant message 塞回历史 + 追加"[引擎提示] 你的输出被 token 上限截断，从你停下的位置直接续写，不要重复"的 user nudge；无 toolChoice，允许 LLM 自然续写叙事；text-delta **正常累加进 fullText + 转发给 onTextChunk**（parser 接着消费，让未闭合 tag 正常闭合）；reasoning-delta 同样转发；usage 逐轮合并
- 续写失败只 warn/log，不冒异常；finishReason='length' 达上限时日志警告并下传给 signal_input follow-up 兜底
- 原 signal_input follow-up 不变（不转发 text-delta、toolChoice 强制 signal_input_needed）；两套 follow-up 互补：先补叙事缺漏（V.5），再补终结工具（方案 A）
- finishReason 类型保持 AI SDK `FinishReason`，直接赋值 `nextFinish`（不 String()）

**V.4 前端消费 / 场景派生（2026-04-24）**
- `src/stores/game-store.ts` `appendSentence` 重写：从 Sentence 派生 `currentScene` + `lastSceneTransition`
  - `scene_change` → 用 `sentence.scene` + 可选 `sentence.transition`
  - `narration` / `dialogue` / `signal_input` / `player_input` → 用 `sentence.sceneRef`
  - 其它分支保留旧值
  - v2 path（scenePatchEmitter=null）无 mid-session scene-change WS 事件，此处承担 store currentScene 的更新责任
  - v1 path 下 WS scene-change 仍然跑 setCurrentScene，此处再写同值 → 幂等，老行为零变化
- VNStageContainer / VNStage 此前已经直接读 `sentence.sceneRef` 做画面，不需改；catch-up / restore 路径自然简化（sentences with sceneRef 重放即把 currentScene 推到最新值）
- **7 个新单测**（`game-store-catchup.test.ts`）：narration 驱动 currentScene、连续 narration sceneRef 变化跟随、dialogue 派生、scene_change+transition 驱动 lastSceneTransition、scene_change 无 transition 保留既有值、signal_input / player_input 派生、首次 append（vsi=null 分支）也派生
- 验证：`bunx tsc --noEmit` 干净；`bun test src/core src/stores` 248/248；`cd server && bun test` 141/141

## 之前的里程碑
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
| 2026-04-25 | op-kit 单源 Operation 层（迁移 14 个 MCP tool + ALL_OPS 单一注册点 + 8 条防腐契约） | routes/mcp.mts 1378 行业务+协议混合体；同一能力 RESTful + MCP 写两遍 schema 漂移；要为将来换 RPC 框架（tRPC/Hono RPC）留扩展口 | mcp.mts 瘦到 281 行（纯 JSON-RPC 协议层）；HTTP /api/ops/* 自动派生；OpMeta.mcpName 字段做 backward compat 让旧客户端配置免改；op canonical name 强制 `<category>.<verb>` 格式；防腐契约贴在 op-kit.mts 顶部 |
| 2026-04-25 | 把 op-kit 这条线纳入 feature_list（OP.0-OP.7 + roadmap）；之前 op-kit 4 batch + first op 都没编号 | op-kit 是 platform refactor 不是 v2.0.md 列出的 product feature，CLAUDE.md 工作流默认通过 feature_list 接续上下文，没编号下次 context reset 看 feature_list 看不出 op-kit 在做什么 | feature_list.json +7 entries（OP.0-OP.4 done / OP.5-OP.7 pending）；docs/refactor/op-kit-roadmap.md 全貌；docs/refactor/op-a-extract-referenced-ids-plan.md self-contained 给 OP.5 开工 |
| 2026-04-26 | `__npc__` 后缀禁代词 + parser 对代词后缀 emit `dialogue-pronoun-as-speaker`（**替代**而非追加 `dialogue-adhoc-speaker` 中性事件） | trace 复盘显示 LLM 把第二人称代词"你"套 NPC 显示名模式产出 `__npc__你`，UI 渲染出名叫"你"的 NPC 气泡。NPC few-shot 全是中文显示名 vs 玩家 reserved id `player` 是英文裸字符串，模式不对称促成误用；选"替代"是为了避免每个 dialogue 的 speaker 类信号在 trace 上双计数 | tag-schema 加 `PRONOUN_DISPLAY_NAMES` + `isPronounSpeaker`；reducer ad-hoc 分支分流；DegradeCode 加新值；v2 prompt `__npc__` 章节列禁词 + 反例 `__npc__你` vs `to="player"`。后续可能把 `player` 包成 `__player__` reserved id（双下划线对称）让 prompt 模式一致 |
| 2026-04-26 | `<dialogue>` 正文边界教学只走 prompt，不做 parser 硬校验 | 引号检测启发式 false positive 高（中文 ""/英文 \"\" 混用 + 内心独白引号 + 角色嵌引语都常见），启发式信号噪比差；prompt 教学性价比明显更高 | engine-rules `<dialogue>` 容器解释加"正文只装直接引语，旁白动作走 `<narration>`"硬规则；反面示范段加用户 trace 截取的"俄罗斯？...大拇指..."三单元拆分案例 + LLM 自检启发（"用角色声音念这段会不会别扭"）。如果 trace 信号回来还是大量漏判，再考虑加软启发（例如 `<dialogue>` 正文里检测"他/她+动词"模式） |
| 2026-04-26 | empty-narrative 整轮只输出 `<scratch>` 走双层兜底（prompt 硬规则 + llm-client follow-up），不在 game-session 层做 | prompt 不是 100% 可靠（reasoning 模型偶发"复盘完就停"），但又不想把"补一句叙事"硬塞到 game-session 让它知道 prompt 协议细节。llm-client 已经有续写 + signal 补刀两个 follow-up 模式，加第三个最对称、调用方无感 | llm-client.generate() 三 follow-up 串联 `续写 → empty-narrative → signal`；每个独立失败 warn/log 不冒异常；engine-rules.test.mts 加 prompt 守门测试避免硬规则被无意删除 |
| 2026-04-26 | signal_input 历史回放给 LLM 时 strip `choices`，只留 `prompt_hint` | trace ece7e31d turn 5→6 实锤：玩家 freetext 答非选项时，LLM 把上轮 `tool_calls.arguments` 里的"未被选中候选"当成玩家说过的话写进了 NPC 引用台词。choices 是 UI 渲染参数不是叙事 ground truth；prompt_hint 是 LLM 自己写的局面总结不易被误读 | persistence 层 / current-readback / tracing 全不动，DB 仍保留 choices；LLM 失去"我上轮提了哪 4 个选项"的记忆，但这不是叙事推进所需信息。如果将来要 LLM 记得，可改成只回放"被选中的那条 + selectedIndex" |
| 2026-04-26 | dialogue speaker 立绘兜底触发条件用"speaker 不在 resolved sprites"（更宽），不用用户字面的"pendingSprites 为空"（更窄） | trace 784ab8fc 现场是字面规则就够用的浅 case，但同源问题还有两类更深：(a) LLM `<stage/>` 清场后忘了补 speaker；(b) LLM 摆了配角立绘但忘了主对话角。窄规则只修第一类；宽规则三类都覆盖且实现成本一样 | 极少数边缘情形（LLM 故意要"voice from offstage"叙事效果）会被兜底覆盖，但 LLM 表达这种意图本就该用 `<narration>` 而不是 `<dialogue>`。Position 优先 center → left → right；3 个全满 emit `no-position` 事件后跳过不阻断 |
| 2026-04-26 | Memorax adapter ID 模型用 `user_id=systemUserId / agent_id=playthroughId / app_id=ivn-editor`（不用 mem0 的 `user_id=playthrough-${playthroughId}`），retrieve 强制 `filters.agent_id.eq` 隔离 | Memorax 有多层 ID hierarchy 而 mem0 只有单层 user_id。把 systemUserId 放 user_id 字段保留"跨存档聚合此玩家"的可能（filter 去掉就行），同时 agent_id 强制做 per-playthrough 隔离永不串档。mem0 那边维持 `playthrough-${id}` 不动（mem0 没 agent_id 概念，metadata filter 也不灵敏），两个 store 的写入 user_id 不一致是设计预期 —— ParallelMemory 是 fallback 关系不是写入对齐 | mem0/memorax adapter 各自隔离独立；将来想做"全玩家所有存档的全局记忆"分析直接拿 user_id 跨档 query Memorax；mem0 仍只能按 playthrough 查 |
| 2026-04-26 | Memorax 失败信号通过 `meta.error` 而非 throw 传给 ParallelMemory | 让 MemoraxMemory 单独使用（eval / 单 provider 配置）也不会炸 game-session（contract 是 retrieve 永不抛）；ParallelMemory 检 meta.error 决定 fallback 是个简单且 typed 的协议，不需要 try/catch wrapper。`appendTurn` / `pin` 用 fire-and-forget + console.error 同模式不影响游戏循环 | MemoraxMemory.retrieve 内部 try/catch + 返回 `{summary:'',meta:{error:reason}}`；ParallelMemory.retrieve 看 meta.error 就 fallback，看到抛错也 fallback（双兜底）；meta.attempted 累积失败历史给 trace |
| 2026-04-26 | Memorax adapter `appendTurn` 用 `async_mode=true`（fire-and-forget），`pin` 用 `async_mode=false`（同步等服务端确认） | Memorax 的 add 内部跑 LLM 抽取最坏 5-30s，同步会卡住每轮 generate。但 pin 是显式"重要记忆"语义，不能容忍丢失（pin 频次低 + 一次额外 HTTP 成本可接受）。同 mem0 adapter 同模式 | appendTurn 失败靠服务端 PENDING 队列重试 + console.error log；pin 失败立刻 console.error 但仍返回 entry（caller 不感知，重启时 pin 再发即可） |
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
