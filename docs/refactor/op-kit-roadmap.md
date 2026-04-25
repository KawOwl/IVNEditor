# op-kit Roadmap — 重构 trunk + 业务能力扩展

**起点**: commit `f843d61`（2026-04-25）— op-kit 单源 Operation 定义 + 第一例 `script.lint_manifest`
**当前状态**: OP.0-OP.4 完成（14 个 MCP tool 全部迁完）；OP.5-OP.7 P0 lint 套件 plan 就绪未开工

---

## 一、为什么有这条线

### 问题

迁移前，`apps/server/src/routes/mcp.mts` 是 1378 行的"业务能力 + JSON-RPC 协议层"混合体：每个 MCP tool 是手写的 `ToolDef`（含 zod schema + handler + auth + error 翻译），同一个业务能力在 RESTful 路由 `routes/scripts.mts` 又写一遍 schema + handler。schema 漂移、错误码不一致、加新能力要写两遍。

### 解法

把"业务能力"抽到 `apps/server/src/operations/` 单源 Operation 层：

```
apps/server/src/operations/
├── op-kit.mts              ← Op<I,O> + defineOp + runOp + checkAuth
├── errors.mts              ← OpError + 8 种 code
├── context.mts             ← OpContext (框架无关)
├── registry.mts            ← ALL_OPS 单源
├── adapters/
│   ├── http.mts            ← buildOpRouter (Elysia plugin)
│   └── mcp.mts             ← opsToMcpTools (转 ToolDef[])
└── script/
    ├── _shared.mts         ← findSegment / getBaselineVersion / resolveTargetVersion
    ├── _asset-helpers.mts  ← uploadImageBytes / upsert helpers
    ├── lint-manifest.mts   (read)
    └── ... (14 个 op)
```

**单源原则**：HTTP route + MCP tool + 将来的 OpenAPI / 前端 typed client 都从同一个 `Op<I,O>` 派生，零定义复制。`registry.mts::ALL_OPS` 是唯一注册点。

### 防腐契约（op-kit.mts 顶部）

为了"将来换 RPC 框架（tRPC / Hono RPC）成本不会 ×3"，op-kit.mts 顶部贴了 8 条契约。摘要：

1. `Op<I,O>` 不依赖 web 框架（不许 import elysia / hono）
2. `exec(input, ctx)` 用 `OpContext`（不是 framework Identity）
3. 错误用 `OpError(code, msg)`，不许 `throw new Error(...)`
4. Zod schema 命名 export，不内联到 `defineOp`
5. ops 不依赖 `routes/`
6. exec 不返回 Response / Headers / Set-Cookie
7. 不在 exec 里做 cookie / session
8. dry-run / undo / progress 这类元能力做 `OpMiddleware`（v0.1 占位未实现）

详见 `apps/server/src/operations/op-kit.mts:1-30`。

---

## 二、已完成（OP.0 - OP.4）

| ID | 标题 | Commit | 关键产出 |
|----|------|--------|----------|
| OP.0 | op-kit bootstrap + script.lint_manifest | `f843d61` | op-kit / errors / context / adapters 框架；首个 op；trace b45a0df9 根因诊断工具 |
| OP.1 | Batch 1: 6 个 read tool 迁移 | `eb60eaa` | mcp.mts 1378 → 1119 (−259) |
| OP.2 | Batch 2: 3 个 write tool 迁移 | `65bfb20` | mcp.mts 1119 → 950 (−169) |
| OP.3 | Batch 3: 3 个 asset write tool 迁移 | `338ae1a` | mcp.mts 950 → 386 (−564，本批最大瘦身) |
| OP.4 | Batch 4: destructive delete_script + 收尾 | `91aa9ce` | mcp.mts 386 → 281；14 个 op 全部完成 |

`mcp.mts` 剩余 281 行全是协议层（JSON-RPC 2.0 dispatcher + ToolDef interface + Elysia route 挂载 + auth + CORS preflight），加新 MCP tool 不再需要碰这个文件。

详细报告：
- `docs/refactor/negentropy-2026-04-25-op-kit-bootstrap.md`（OP.0）
- `docs/refactor/negentropy-2026-04-25-mcp-tool-migration.md`（OP.1-OP.4 总览）

---

## 三、下一批：P0 lint 套件（OP.5 - OP.7）

### 业务问题

LLM runtime 因为剧本 manifest 没登记某个 background/character 而 degrade（v2 协议下表现为 `<background scene="city_street_morning" />` 但 `manifest.backgrounds[]` 是空的，trace `b45a0df9` 是真实样本）。作者**无工具感知**这个问题，要等 runtime 跑出来才知道；agent **无能力自动修复**。

### 目标

让"修复型 agent"（或人类作者）有完整工具链做"诊断 → 提议 → 修复"闭环：

| 步骤 | 工具 | 状态 |
|------|------|------|
| ① 看最近哪些剧本有 degrade | `script.list_recent_degrades` | **OP.6**（待做） |
| ② 对该剧本跑 lint，看 manifest 缺什么 | `script.lint_manifest` | ✅ 已有（OP.0） |
| ③ 看剧本实际引用了哪些 ID（agent 决策上下文） | `script.extract_referenced_ids` | **OP.5**（待做） |
| ④ 拿到具体 patch dry-run | `script.propose_manifest_alignment` | **OP.7**（待做） |
| ⑤ confirm → apply 生成 draft 版本 | `script.replace_manifest`（apply 路径） | ✅ 已有（OP.2） |
| ⑥ 上线修复 | `script.publish_version` | ✅ 已有（OP.2） |

闭环六步里 **②⑤⑥ 已有**，**①③④ 是 P0 lint 套件要补的**。

### 顺序：A → B → C，每个独立 commit + push

**OP.5 = Op A: `script.extract_referenced_ids`**
- 详细 plan：`docs/refactor/op-a-extract-referenced-ids-plan.md`
- 依赖：纯抽取，零外部依赖
- 复用 `lint-manifest._internal.extractFromSegment` + `_shared.resolveTargetVersion`
- 单测 7 条走纯函数 path，可能不需要 DB

**OP.6 = Op B: `script.list_recent_degrades`**
- 接 Langfuse public API 拉最近 N 小时的 `ir-degrade:*` 事件，按 (code, detail) 聚合
- input: `{ scriptId?, hours?, limit? }`（默认 hours=24, limit=200）
- output: `{ windowHours, traceCount, totalDegrades, byCode: [{ code, detail, count, sampleTraceIds }] }`
- 实现要点：
  - 用 fetch 直接调 `${LANGFUSE_HOST}/api/public/observations` + Basic auth（`LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`）
  - 查询：`observations` 接口 + `name like 'ir-degrade:%'` 过滤
  - **写之前先 curl 一个真实 trace 看 metadata 形状**：scriptId 关联在 trace `metadata.scriptId` 还是 `trace.userId`(playthroughId) join scripts？trace `b45a0df9-38a1-4ee0-9126-ffcecf57da73` 是已知的 `bg-unknown-scene` / `detail=city_street_morning` 样本
  - env 缺时返回 `OpError('UPSTREAM_UNAVAILABLE', 'Langfuse not configured')` 不崩
- 单独写 plan 文件 `docs/refactor/op-b-list-recent-degrades-plan.md` 再开工

**OP.7 = Op C: `script.propose_manifest_alignment`**
- 基于 `script.lint_manifest` findings 自动给出 manifest patch dry-run
- input: `{ scriptId, versionId?, applyMode? }`（默认 `'dry-run'`，传 `'apply'` 真生成 draft 版本）
- dry-run 输出：完整 patched manifest（在原 manifest 上新增缺失的 backgrounds/characters/emotions 占位项，`assetUrl` 留空待上传）+ 人读 summary
- apply 输出：调用 `replaceManifestOp.exec` 落 draft 返回新 versionId
- 实现要点：
  - 本质是 lint-manifest findings → manifest patch 的纯函数映射，逻辑放 `_shared.mts` 可测纯函数 `alignmentPatch(manifest, findings)`
  - 设计待定：单 op + `applyMode` 字段 vs 两 op（propose + apply）；前者更简洁，后者 `effect` 字段更准确（`safe` vs `mutating`）
- P0 套件最复杂的 op，先做 OP.5 / OP.6 探清模式
- 单独写 plan 文件 `docs/refactor/op-c-propose-manifest-alignment-plan.md` 再开工

---

## 四、更下游（未排期，backlog）

来自 OP.4 negentropy 报告的 follow-up：

| ID 草拟 | 标题 | 触发条件 |
|---------|------|----------|
| OP.8 | OpenAPI 自动生成 | 任何时候，`zod-to-openapi` 一行就能产出 swagger.json，给 SDK / dashboard 用 |
| OP.9 | `withConfirm` middleware | 等到第 2 个 `effect: 'destructive'` op 出现（候选：bulk_delete_versions / restore_archived_version），把 OP.4 手写的两阶段确认抽公共部分 |
| OP.10 | 前端切到 `callOp` | 现在 `ScriptInfoPanel` / `EditorPage` 还在直接 fetch `/api/scripts/*` 旧 RESTful，可以渐进切到 typed `callOp` API（共享 op 定义获得完整类型推断） |

不进 `feature_list.json` —— 等明确要做的时候再加 ID。

---

## 五、与现有 V.x IR 工作的关系

`PROGRESS.md` 主线是声明式视觉 IR (V.1 - V.7)，op-kit 是平行的"工程基础设施"线：

- **V.x 是 product feature**：parser / system prompt / session 接线 / 编辑器 UI
- **OP.x 是 platform refactor + 业务能力**：让"加新 MCP tool / HTTP endpoint"这件事变快
- **P0 lint 套件直接服务 v2 IR**：v2 协议下 manifest 一致性问题是 v2 才有的（v1 用 tool call，runtime 校验天然兜底；v2 用声明式标签，作者写错没人检查）

所以两条线最终汇流。
