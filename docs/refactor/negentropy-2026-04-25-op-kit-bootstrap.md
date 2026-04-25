# Negentropy Report - 2026-04-25 op-kit Bootstrap

Command:

```bash
negentropy analyze . --format json --fail-on none --output /tmp/ivn-negentropy-opkit.json
```

Exit code: `0`（`--fail-on none`）。

## Summary

- Tool version: `0.1.0`
- Files scanned: `189`（前一次扫的 167，本次 +22 是新加的 op-kit / adapters / lint-manifest 7 个文件 + 测试 + 已有非 `.mts` 临时脚本）
- Modules: `189`
- Overall risk: `High`（继承自既存 hotspot，op-kit 自身**未引入新 hotspot**）

## Dimensions

| Dimension | Metric | Raw | Risk | 备注 |
| --- | --- | ---: | --- | --- |
| module_abstraction | IIE | `0.008` | Low | 无变化 |
| logic_cohesion | EAD | `2.0` | Medium | 无变化 |
| change_blast_radius | TCR | `0.0` | Low | 无变化 |
| architecture_decoupling | TCE | `0.0` | Low | 无变化 |
| testability_pluggability | EDR | `0.86` | Low | 略升（+0.01）—— 新增的 op-kit 单测和服务层有耦合占了少量比例，仍 Low |
| intent_redundancy | PLME | `1.25` | High | 历史背景值，无变化 |
| state_encapsulation | SSE+OA | `{oa:0.041, sse:1.769}` | High | 历史背景值；op-kit 文件没贡献新的 SSE/OA |

## Refactor Impact

- 新增 `apps/server/src/operations/` 目录，单源 Operation 定义 + 两个 adapter（HTTP / MCP）：
  - `op-kit.mts` —— `Op<I, O>` 类型 + `defineOp` 工厂 + `runOp` 执行器 + `checkAuth` + `indexOps`，**不依赖任何 web 框架**
  - `errors.mts` —— `OpError` 类型化错误 + 8 种 code + `opErrorToHttpStatus` 映射
  - `context.mts` —— `OpContext`（框架无关身份上下文）+ `identityToOpContext` 转换
  - `adapters/http.mts` —— Elysia 插件 `buildOpRouter(ops)`，挂 `POST /api/ops/:name`（单端点 dispatch）+ `GET /api/ops`（发现）
  - `adapters/mcp.mts` —— `opsToMcpTools(ops)` 把 op 转 MCP `ToolDef[]`，zod 4 自带的 `toJSONSchema` 转换 schema
  - `script/lint-manifest.mts` —— 第一例 op：检查段落正文里引用的 background / character / emotion id 是否在 manifest 白名单里
  - `registry.mts` —— `ALL_OPS` 单源注册点
- `app.mts` 加 `.use(buildOpRouter(ALL_OPS))`，HTTP 自动暴露
- `routes/mcp.mts` 加 `tools.push(...opsToMcpTools(ALL_OPS))`，MCP 自动暴露
- 没动任何已有 service / route，纯加法

## op-kit Hotspot Check

filter `'operations' in location`：**0 hotspot**

新模块的写法守住了防腐契约（见 `op-kit.mts` 顶部 8 条），所以新增了 7 个文件（含测试）但 negentropy 没扫出新 hotspot。

## Verification

- `bun test src/operations/` （apps/server）—— 39/39 pass，64 expect 调用
- `cd apps/server && bun --env-file=.env.test test` —— 181/181 pass（之前 142 + 新增 39）
- `cd packages/core && bun test` —— 248/248 pass（无影响）
- `cd apps/server && bun x tsc --noEmit` —— clean
- `cd packages/core && bun x tsc --noEmit` —— clean
- 起 server 跑 smoke test：
  - `GET /api/ops` 返回 op 列表（含 `script.lint_manifest`）
  - `POST /api/ops/script.lint_manifest`（admin Bearer）→ 200 ok + 真实 lint 报告
  - 同 op 通过 MCP `tools/list` + `tools/call` 端到端跑通，输出形状一致
  - 错误路径 401（unauth）/ 400（bad input + zod 错误细节）/ 404（NOT_FOUND）都按预期映射

## Current Top Hotspots（与 op-kit 无关）

仍是上次留下的：
- `packages/core/src/game-session.mts::anonymous@712`：external attribute reads
- `apps/server/src/routes/sessions.mts::open`：external attribute reads
- `apps/ui/src/ui/App.tsx::publicInfoToManifest`：external attribute reads
- `packages/core/src/schemas.mts`：high IIE
- `apps/server/src/db/schema.mts`：high IIE
- `packages/core/src/__tests__/*` 系：high SSE（测试 fixture 自然结果）

## Follow-up

下一步把 P0 lint 这一组的剩下两个 op 同样落到 op-kit 里：

1. `script.extract_referenced_ids` —— 复用 `lint-manifest.mts` 的提取逻辑，输出"段落正文里出现的所有 ID"的 raw 集合（不做白名单 diff，给 agent 当上游数据用）
2. `script.list_recent_degrades` —— 接 Langfuse public API，按 trace tag 拉最近 N 小时的 `ir-degrade:*` 事件，按 detail 聚合

之后逐个把 `routes/mcp.mts` 现有 14 个 ToolDef 改写成 op，过渡期间共存。
