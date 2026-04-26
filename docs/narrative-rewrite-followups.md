# Narrative Rewrite — 剩余 Follow-ups

> 基线：截至 commit `5dace1b`（2026-04-26），改进 A / B / C1 + post-step signal
> final fallback + engine-rules legacy v1 清理 + v2 字节稳定 snapshot 都已合入
> main。本文件记录尚未落地的待办，按优先级排列。

---

## 已落地链路（截至 5dace1b）

```
main agentic loop（llm-client.generate）
  ├─ step 0/1/2/...                            ← LLM 主步骤（含 tool calls）
  ├─ continuation followup                      ← length truncation 续写（最多 3 次）
  ├─ post-step signal followup                  ← 强制调 signal_input_needed（tools=all）
  └─ post-step signal final fallback            ← 5dace1b 新增（tools 只剩 signal_input_needed）
↓ generate() return
generate-turn-runtime.completeGenerateTurn
  ├─ finalizeNarrativeOutput（parser-v2 第一次 finalize）
  ├─ runRewriteIfEnabled                        ← 100% 流量
  │   ├─ rawText = currentTurnRawText（含 preflush 切走的 prose 段，B 修通视野）
  │   ├─ rewriter system prompt = engine-rules 子段同源（A 修通漂移）
  │   ├─ user message degrade 段含软提醒 + 判断要点（C1 修通误判风险）
  │   ├─ rewrite call → verifyParse(text)
  │   │   ├─ ok（sentenceCount > 0）→ replace currentNarrativeBuffer + replay parser
  │   │   └─ fail → retry 1 次 → 仍 fail 则 fallback 到 raw
  │   └─ applied=true 时落 narrative-segment-finalized reason='rewrite-applied'
  ├─ persistGenerateResult
  │   └─ messages-builder 投影时跳过被 rewrite-applied 覆盖的 turn 内 segment
  └─ generate-turn-completed
```

UI 端：rewrite 期间 `RewriteOverlay` 半透明遮罩 + "AI 正在审稿…" 文案，
完成后 fade-out + UI 重新接收 narrative-batch-emitted 渲染 rewrite 输出。

---

## 待办（按优先级）

### P0 — 生产数据观察 + 决策依据收集

**目标**：积累 production trace 看改进 A/B/C1 的实际效果，作为后续 P1/P2 决策依据。

**做什么**：
- 持续监控 langfuse 上 `narrative-rewrite` nested generation 的 trace
- 关键指标：
  - rewrite 触发率（应当 ~100%，验证 100% 流量正常工作）
  - `applied=true` 比例（rewrite 真的替换 buffer 的频率）
  - `verifiedSentenceCount > 0` 比例（rewrite 输出能 parse 出 sentence 的频率）
  - rewrite 后的 degrade 比例（特别是 `dialogue-adhoc-speaker` 跟改进 A 之前对比）
  - `rewrite-completed.fallbackReason` 分布（api-error / second-parse-failed / aborted）
  - 平均 rewrite latency / token 用量
- harness 改进：rewrite 是纯函数，可以直接灌 production trace 跑离线 eval

**完成定义**：积累 ≥ 100 条 production trace 后做一次数据 review，
形成 dashboard 截图 + 数字判断 P1/P2 是否需要做。

---

### P1 — 改进 C2：verify-on-degrade retry（按 P0 数据决定是否需要）

**触发前提**：P0 数据显示 rewrite 输出仍含相当比例的 actionable degrade
（如 `dialogue-adhoc-speaker` 漏修），改进 A + C1 不够用。

**设计**：
- [`rewriter.mts`](packages/core/src/narrative-rewrite/rewriter.mts) verify 通过条件改严：
  从 `sentenceCount > 0` 改成 `sentenceCount > 0 && actionable_degrade_count === 0`
- "actionable degrade" 分类：
  - **Actionable**（rewriter 能修，触发 retry）：
    `bare-text-outside-container` / `unknown-toplevel-tag` / `unknown-close-tag`
    / `bg-missing-attr` / `sprite-missing-attr` / `sprite-invalid-position`
  - **Non-actionable**（不触发 retry）：
    `dialogue-adhoc-speaker` ✗ —— 不一定是错（合规 ad-hoc 也 emit）
    `container-truncated` ✗ —— rewriter 不能补内容
    `sprite-unknown-char` / `sprite-unknown-mood` ✗ —— 白名单问题
- retry 时给 rewriter 看自己上次输出的 degrade 列表 + 修复建议
- maxRetries 已经 = 1，不需要新增

**风险**：
- 多 1 次 LLM call（仅 actionable degrade > 0 时）
- 如果 rewriter 反复修不干净 → 浪费 retry，最终 fallback 到第一次输出

**改动量**：rewriter.mts verify 路径调整 + 测试覆盖。半天落完。

---

### P2 — UI 测试覆盖 RewriteOverlay 流式行为

**问题**：当前 RewriteOverlay 组件代码 review 过 + ws-message-handlers 单测覆盖了
state actions（setRewriting / resetTurnSentences），但缺少**端到端**的 UI
渲染验证（fade-in / fade-out 时序、半透明值、文案位置）。

**做什么**：
- 在 staging 起 dev server 进 PlayPanel
- 模拟 rewrite-attempted / narrative-turn-reset / rewrite-completed 序列
- 用 preview_screenshot 验证遮罩出现 + 文案 + reveal 动画

**前置依赖**：staging DB schema mismatch（auth/init 500）必须先修通——目前
spawned task 在 backlog 跟踪。如果 staging 修不动，可以本地用 ivn-test env
绕过。

---

### P3 — production 一次性 history scrub（受影响 playthrough）

**问题**：改进 B 让**未来** rewrite 替换 history segment，但**已有** production
playthrough 的 history 仍含 prose 污染（preflush 落库的）。trace ce3f4473
（14-turn）就是典型例子。

**做什么**：
- 写一次性脚本：扫 staging RDS 找出含 prose-pattern 的 narrative-segment-finalized
  records（按 entry.content 不含 `<dialogue|narration\b` 检测）
- 对每条这样的 segment 跑 rewriter 做 reformat，emit `narrative-segment-finalized`
  reason='rewrite-applied' 替换覆盖
- 让 messages-builder 投影时跳过原 prose segment

**风险**：
- 改写历史数据有审计风险——需要先备份 + 确认 rewrite 输出质量
- production playthrough 可能正在被玩家读 / 写

**触发条件**：用户主动决策（不是自动)。

---

### P4 — eval 视图：harness 直接灌 trace

**目标**：让 narrative-rewrite 模块的纯函数特性能被 harness 直接消费。

**做什么**：
- packages/core/scripts/ 下加一个 `eval-rewrite-replay.mts`：
  - 输入：langfuse trace JSON（或 trace ID + auth）
  - 抽出 raw fullText + parser view + manifest
  - 调 rewriteNarrative 做离线 replay
  - 输出：rewrite 结果 + verify 结果 + 跟原 trace 对比
- harness 集成：跑一批历史 trace 算 fidelity score（rewrite 是否丢内容）

**收益**：
- prompt 改动后能离线 eval 不用上 production
- 找回归更快

---

## 决策记录（已 close）

- ✅ **改进 A**：rewriter prompt 同源 engine-rules + ad-hoc 三档分级
  → commit `38a7e9f`
- ✅ **改进 B**：currentTurnRawText 完整视野 + rewrite-applied 替换 history
  + 删 empty-narrative followup → commit `a360e57`
- ✅ **改进 C1**：parser degrade 段加软提醒 + 3 类判断要点（不强加修复方向）
  → commit `bd65bcf`
- ✅ **engine-rules legacy v1 清理 + 字节稳定 snapshot + post-step signal final
  fallback** → commit `5dace1b`
- ❌ **改进 B 时考虑过的"emit narrative-segment-superseded 新事件类型"**
  → 改用复用 `narrative-segment-finalized` + reason='rewrite-applied' 标记，
  避免新增协议事件类型
- ❌ **C1 初版"degrade 标'必修清单 + 修复方向'"**：用户反驳后改成软提醒
  + 判断要点；不强加修复方向，让 LLM 看 raw 上下文 + system prompt 规则
  自行决定

---

## 关键 trace 索引

- `ce3f4473-dc56-4bd4-89bd-ebf958984729` — 14-turn 全 prose 暴露（A 之前）
- `bab24e15-04ae-48b5-90a8-8a2c11f88972` — parser scratch raw region bug
  → fix `e46fa00`
- `227cb1d0-bb55-4659-b177-f010d0eb7f19` — rewrite 第一次跑出 dialogue-adhoc-speaker
  漏修 → 触发 A / B / C1 改进
- `25c6863d-6436-4a27-86aa-6e9918947be7` — session 级 trace（待分析效果）
