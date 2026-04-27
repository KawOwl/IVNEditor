# Playbook · 玩家活动分析

针对一个时间窗内"哪些玩家在玩、玩到哪、是否卡住"的复现性分析流程。
适用场景：班级演示、灰度放量、bug 报告聚集后的复盘等。

---

## 1. 输入

唯一必需输入：**时间窗** `[T_start, T_end]`，含时区。
其它一切（剧本名单、用户群体、是否压测）从数据里推出来，不需要用户预说明。

时区处理铁律：
- 用户给的窗口默认按业务时区（UTC+8）。
- 所有 SQL 和 tracing API 用 **UTC** 查询，第一步先把窗口转成 UTC。
- 报告里把分钟级聚合两栏并列展示（UTC + UTC+8）以便对照。

---

## 2. 数据源（按性质，不绑定具体系统）

这套流程依赖两类数据，未来同性质系统可整体替换：

### 2.1 业务数据库（关系型 / Postgres 风格）

承载用户、剧本版本、playthrough、事件流、玩家自填问卷。
**关键表与字段**（项目特定语义，不会因后端迁移而变）：

| 表 | 用途 | 关键字段 |
|---|---|---|
| `playthroughs` | 一次游玩会话 | `id`, `user_id`, `script_version_id`, `kind`('production' / 'playtest'), `status`, `turn`, `created_at`, `updated_at` |
| `users` | 统一用户表 | `id`, `email`(注册玩家非空，匿名为 NULL), `role_id`('admin'/'user'), `created_at` |
| `user_profiles` | 注册用户 6 题画像 | `affiliation`, `gender`, `grade`, `major`, `monthly_budget`, `hobbies`(jsonb 数组) |
| `feedback` | 玩家自提问卷（Q1-Q5） | `q1`..`q5`, `q4_other`, `created_at` |
| `bug_reports` | 玩家自提 bug 描述 | `description`, `playthrough_id`, `turn`, `created_at` |
| `core_event_envelopes` | 逐轮事件流 | `playthrough_id`, `sequence`, `occurred_at`(ms epoch), `event`(jsonb，含 `type` 字段) |
| `script_versions` + `scripts` | 剧本身份 + 版本快照 | `label`(剧本名), `manifest`, `version_number` |

**核心 event types（出现在 `core_event_envelopes.event->>'type'`）**：

- 启动/结束：`session-started`, `session-restored`, `session-stopped`, `session-finished`, `session-error`
- 一轮 LLM：`generate-turn-started` → `generate-turn-completed`
- 重试：`retry-main-attempted`, `retry-main-completed`
- 内存：`memory-retrieval`, `memory-compaction-started/completed`
- 玩家输入：`player-input-recorded`, `signal-input-recorded`
- 叙事流：`assistant-message-started/finalized`, `narrative-batch-emitted`, `narrative-segment-finalized`
- 改写：`rewrite-attempted`, `rewrite-completed`

### 2.2 LLM tracing（Langfuse 风格）

承载每次 LLM 调用的 trace + observation。可被任何 OpenTelemetry-style LLM 观测平台替换。
**项目侧的 trace 命名约定**：

- `trace.name`: `'game-generate'` 是主类型（一次玩家输入 → 一轮叙事生成）；`'session-restored'` 是断线重连
- `trace.tags`: 含 `'production'` 或 `'editor-playtest'`
- `trace.userId`: 对应业务库 `users.id`
- `trace.sessionId`: 对应业务库 `playthroughs.id` —— **这是关键 join key**
- `observation.name`: `'narrative-main'`, `'narrative-rewrite'`, `'narrative-retry-main'` 等
- `observation.type='GENERATION'`: 实际 LLM 调用，含 `model`, `latency`, `usageDetails`, `level`('ERROR' / null)
- `observation.startTime` / `endTime` / `latency`(秒)

### 2.3 接入约定（不要写死在 playbook 里）

具体如何到达上述两个数据源（私网入口、kubeconfig、API key、是否需要绕 SSL 等）由当前环境决定。
执行时先查 auto memory 里 `staging-endpoints` / `*-endpoints` 类条目，或问用户当前是 staging / prod。

执行环境的极小要求：
- 一个能直连业务 DB 的节点
- 一个能调 tracing API 的节点
- 任意 JS runtime（bun / node）+ `pg` 驱动用于跑 SQL

> **本项目 staging 当前坑**：`DATABASE_URL` 里写了 `sslmode=require`，但 RDS 实际禁了 SSL，业务 server 用 env `PG_SSL=off` 强制关 ssl。复用 server 的 DB 连接时要 strip 掉 URL 里的 `sslmode=` 然后传 `{ ssl: false }`。

---

## 3. 分析步骤

按这个顺序跑。每一步产出表，全部读完才下结论。

### Step 1 — 规模总览

```sql
SELECT
  p.kind,
  u.role_id,
  CASE WHEN u.email IS NULL THEN 'anon' ELSE 'registered' END AS user_type,
  COUNT(*) AS n_playthroughs,
  COUNT(DISTINCT p.user_id) AS n_users,
  COUNT(DISTINCT p.script_version_id) AS n_script_versions
FROM playthroughs p
JOIN users u ON u.id = p.user_id
WHERE p.created_at >= $1 AND p.created_at < $2
GROUP BY ROLLUP (p.kind, u.role_id, user_type);
```

并排查窗口内**新建用户数**：

```sql
SELECT
  CASE WHEN email IS NULL THEN 'anon' ELSE 'registered' END AS user_type,
  role_id,
  COUNT(*)
FROM users
WHERE created_at >= $1 AND created_at < $2
GROUP BY 1, 2;
```

并排按剧本聚合：

```sql
SELECT s.label, COUNT(*) AS n, COUNT(DISTINCT p.user_id) AS n_users,
       AVG(p.turn)::numeric(10,2) AS avg_turn, MAX(p.turn) AS max_turn
FROM playthroughs p
JOIN script_versions sv ON sv.id = p.script_version_id
JOIN scripts s ON s.id = sv.script_id
WHERE p.created_at >= $1 AND p.created_at < $2 AND p.kind='production'
GROUP BY s.label;
```

### Step 2 — 用户漏斗

`status × kind` 分布、`turn` 桶分布（0 / 1-3 / 4-9 / 10+）、是否过 turn 0。
关注两个数：
- **`turn=0` 占比**：创建了但没真正玩；占比高 = 启动门槛/首屏问题
- **`status='generating'` 占比**：截图时仍活跃；接近 1 说明窗口尾部还在跑，"finished" 数会被时间窗截断

### Step 3 — 稳定性

```sql
-- session-error 实例（最直接的失败）
SELECT ev.playthrough_id, ev.event
FROM core_event_envelopes ev
JOIN playthroughs p ON p.id = ev.playthrough_id
WHERE p.created_at >= $1 AND p.created_at < $2
  AND ev.event->>'type' = 'session-error';

-- retry 比例
SELECT COUNT(DISTINCT p.id) AS pt_with_retry, SUM(...) AS n_retries
FROM playthroughs p
JOIN core_event_envelopes ev ON ev.playthrough_id = p.id
WHERE p.created_at >= $1 AND p.created_at < $2
  AND ev.event->>'type' = 'retry-main-attempted';
```

Tracing 侧：

```
GET /api/public/observations
  ?fromStartTime=$T_start_utc&toStartTime=$T_end_utc
  &type=GENERATION&level=ERROR
```

聚合 ERROR-level generation 数 / `statusMessage` 关键词。常见已知模式：
- `"No output generated. Check the stream for errors."`
- `"reasoning_content in the thinking mode must be passed back to the API."`（DeepSeek thinking quirk）
- `"The operation was aborted."`（client cancel）

### Step 4 — 玩家直接反馈

按 Q1–Q5 各自做 histogram，再额外列 `q4_other` 的自由文本（数量少，全列出）。
`bug_reports.description` 全部列出 + 对应 `playthrough_id` / `turn` —— 一般 < 20 条，不要聚合，肉眼读。

### Step 5 — Turn × 时间相关性（核心增量分析）

这一步是判断"是否因为前期慢导致玩家放弃"的关键。

#### 5.1 LLM 延迟时间序列

把 langfuse observations 按 `startTime` 分钟聚合，p50 / p90 / p99 / max。
建议同时做"全部 GENERATION"和"只看 heavy calls（`name LIKE 'narrative-main%' OR 'narrative-rewrite%' OR 'narrative-retry-main%'`）"两份 —— 全部数据被大量子秒级小调用稀释，heavy-calls 才反映用户感知。

#### 5.2 启动时段 cohort × 推进

```sql
SELECT
  to_char(date_trunc('minute', p.created_at), 'HH24:MI') AS minute,
  COUNT(*) AS n_pt,
  SUM(CASE WHEN p.turn = 0 THEN 1 ELSE 0 END) AS turn0,
  SUM(CASE WHEN p.turn >= 1 THEN 1 ELSE 0 END) AS turn_ge1,
  SUM(CASE WHEN p.turn >= 3 THEN 1 ELSE 0 END) AS turn_ge3,
  AVG(p.turn)::numeric(10,2) AS avg_turn
FROM playthroughs p
WHERE p.created_at >= $1 AND p.created_at < $2 AND p.kind='production'
GROUP BY 1 ORDER BY 1;
```

#### 5.3 TTFC（Time-To-First-Completed-turn）—— 最重要的一个指标

```sql
WITH first_completed AS (
  SELECT playthrough_id, MIN(occurred_at) AS t1
  FROM core_event_envelopes
  WHERE event->>'type' = 'generate-turn-completed'
  GROUP BY playthrough_id
)
SELECT
  to_char(date_trunc('minute', p.created_at), 'HH24:MI') AS minute,
  COUNT(*) AS n,
  ROUND(AVG((fc.t1 - EXTRACT(EPOCH FROM p.created_at) * 1000) / 1000.0)::numeric, 2) AS avg_ttfc_s,
  ROUND((PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (fc.t1 - EXTRACT(EPOCH FROM p.created_at)*1000) / 1000.0))::numeric, 2) AS p50,
  ROUND((PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY (fc.t1 - EXTRACT(EPOCH FROM p.created_at)*1000) / 1000.0))::numeric, 2) AS p90,
  ROUND(MAX((fc.t1 - EXTRACT(EPOCH FROM p.created_at)*1000) / 1000.0)::numeric, 2) AS max_s
FROM playthroughs p
JOIN first_completed fc ON fc.playthrough_id = p.id
WHERE p.created_at >= $1 AND p.created_at < $2 AND p.kind='production'
GROUP BY 1 ORDER BY 1;
```

注意：TTFC 包含玩家点开剧本到点"开始"之间的人为延迟，但当玩家集中拥入时基本可以忽略（远小于后端排队）。

健康基线：p50 < 30s、p90 < 60s。

#### 5.4 Inter-turn gap（轮间隔）

```sql
WITH g AS (
  SELECT ev.playthrough_id, ev.occurred_at,
         LAG(ev.occurred_at) OVER (PARTITION BY ev.playthrough_id ORDER BY ev.sequence) AS prev_at
  FROM core_event_envelopes ev
  JOIN playthroughs p ON p.id = ev.playthrough_id
  WHERE p.created_at >= $1 AND p.created_at < $2
    AND ev.event->>'type' = 'generate-turn-started'
)
SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY (occurred_at - prev_at)/1000.0) AS p50,
       PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY (occurred_at - prev_at)/1000.0) AS p90
FROM g WHERE prev_at IS NOT NULL;
```

包含玩家阅读时间。p50 > 60s 通常意味着读速 + 后端延迟叠加偏慢。

### Step 6 — bug_reports 时间线 vs 性能曲线对照

把 Step 4 收集到的 bug 描述按 `created_at` 排序，对每条标注：
1. 写者所在的启动 cohort（按 5.2 / 5.3 表查）
2. 当时（描述 created_at 前后 1-2 分钟）的 LLM heavy-call latency

凡是性能词汇（"卡"/"慢"/"打不开"/"无反应"/"加载"）的 bug，几乎一定能在 LLM 延迟曲线找到时间对位 —— 这一步就是把 bug 反馈"接地"到客观数据。

---

## 4. 输出报告骨架

```
## YYYY-MM-DD HH:MM-HH:MM (TZ) 玩家活动分析

### 一句话结论
[规模 + 性能/质量定性]

### 一、规模
- playthroughs / 用户 / 新建用户 / 涉及剧本
- tracing 总 traces / generations / token / cost
- 启动时段曲线（per-minute new sessions）

### 二、用户漏斗
- status × kind
- turn 桶分布
- 过 turn 0 比例

### 三、稳定性
- session-error 数量 + 模式
- retry-main 占比
- LLM ERROR-level + statusMessage 模式

### 四、玩家直接反馈
- feedback Q1–Q5 histogram + 主流模式总结
- bug_reports 全文（< 20 条）+ 分类（性能 / 质量 / 其他）

### 五、Turn × 时间相关性  ← 一定要做
- LLM heavy-call latency per minute
- 启动 cohort × turn 推进 / 过 turn 0 比例 / avg_turn
- TTFC p50/p90/max per cohort
- Inter-turn gap

### 六、bug_reports 接地
- 每条性能词汇 bug 对应到 5 节的延迟曲线点

### 七、行动建议
- 容量 / 副本数 / rate limit / 监控指标
```

---

## 5. 操作要点 & 常见坑

- **kind='production' 过滤是默认开**：编辑器试玩 (`kind='playtest'`) 不属于玩家活动，会污染分布。需要专门看编剧动作时再单独跑一份。
- **窗口尾部截断效应**：`status='generating'` 数 ≈ 截图时还在跑的 session，不是失败。`finished` 计数总是偏低，不要按"通关率"解读。
- **匿名重叠**：一个真人可能创建多个匿名 user（清浏览器、换设备）。`COUNT(DISTINCT user_id)` 是上限不是下限，配合 `users.created_at` 看新建率才能区分"真新人"和"老人重启 session"。
- **疑似机器/重复点击**：每个用户的 playthrough 数远高于平均（比如 50+/小时）通常是反复点 "开始" 没继续。在 Top 用户表里要专门标出。
- **业务库 SSL**：见 §2.3 的注。复用 server 已有 connection string 时记得 strip `sslmode`。
- **tracing 分页**：langfuse `/api/public` 默认 limit=100，要循环 page 直到 `meta.totalPages`。设置 page 上限（200）做安全阀。
- **跨 cluster 时区显示**：Postgres 用 `WITH TIME ZONE`，输出永远是 UTC ISO。报告里要主动加 UTC+8 列，不要让人脑算。
- **读历史数据保护**：所有 SQL 都是 SELECT，不要在生产 DB 跑 UPDATE/DELETE。如果需要修复脏数据，单独提交 PR 评审。

---

## 6. 复现入口

新会话需要做这件事时：
1. 读本文件 + 当前环境的接入 memory（如 `staging-endpoints`）
2. 跟用户确认时间窗（带时区）
3. 按 §3 顺序跑，按 §4 模板写报告
4. 不要省 §5（Turn × 时间相关性）—— 这是回答"为什么 turn 推不动"的唯一方法
