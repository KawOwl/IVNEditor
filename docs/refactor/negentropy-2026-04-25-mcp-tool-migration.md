# Negentropy Report - 2026-04-25 MCP Tool 全量迁移到 op-kit

Command:

```bash
negentropy analyze . --format json --fail-on none --output /tmp/ivn-negentropy-batch4.json
```

Exit code: `0`（`--fail-on none`）。

## Summary

- Tool version: `0.1.0`
- Files scanned: `204`（op-kit bootstrap 时是 189，本次 +15 是 7 个新 op
  + 2 个 `_*-helpers` + 测试，符合预期）
- Modules: `204`
- Overall risk: `High`（继承自既存 hotspot；本次新增内容只贡献 2 个
  logic_cohesion 警告，不改变整体评级）

## 完成范围

把 `routes/mcp.mts` 里**全部 14 个**手写 ToolDef 一个不剩地迁移到 op-kit。

| 顺序 | MCP tool name        | op canonical name              | effect       |
|------|----------------------|---------------------------------|--------------|
| 1    | list_scripts         | script.list_scripts             | safe         |
| 2    | list_script_versions | script.list_versions ⓜ          | safe         |
| 3    | get_script_overview  | script.get_overview ⓜ           | safe         |
| 4    | get_segment          | script.get_segment              | safe         |
| 5    | get_full_manifest    | script.get_full_manifest        | safe         |
| 6    | list_script_assets   | script.list_assets ⓜ            | safe         |
| 7    | (新增) lint_manifest | script.lint_manifest            | safe         |
| 8    | update_segment_content | script.update_segment_content | mutating     |
| 9    | replace_script_manifest | script.replace_manifest ⓜ    | mutating     |
| 10   | publish_script_version  | script.publish_version ⓜ     | mutating     |
| 11   | upload_script_asset  | script.upload_asset ⓜ           | mutating     |
| 12   | add_background_to_script | script.add_background ⓜ     | mutating     |
| 13   | add_character_sprite | script.add_character_sprite     | mutating     |
| 14   | delete_script        | script.delete_script            | destructive  |

ⓜ = 通过 `OpMeta.mcpName` 字段做 backward compat：op canonical name
干净（不含冗余 `script_` 前缀），但 MCP 对外名保持原样不变，旧客户端
配置完全无需改。

## 文件结构

```
apps/server/src/
├── operations/
│   ├── op-kit.mts              ← Op<I,O> + defineOp + runOp + checkAuth
│   ├── errors.mts              ← OpError + 8 种 code
│   ├── context.mts             ← OpContext (框架无关)
│   ├── registry.mts            ← ALL_OPS 单源
│   ├── adapters/
│   │   ├── http.mts            ← buildOpRouter (Elysia plugin)
│   │   └── mcp.mts             ← opsToMcpTools (转 ToolDef[])
│   ├── script/
│   │   ├── _shared.mts         ← findSegment / getBaselineVersion / ...
│   │   ├── _asset-helpers.mts  ← uploadImageBytes / upsert helpers ...
│   │   ├── lint-manifest.mts   (read)
│   │   ├── list-scripts.mts
│   │   ├── list-versions.mts
│   │   ├── get-overview.mts
│   │   ├── get-segment.mts
│   │   ├── get-full-manifest.mts
│   │   ├── list-assets.mts
│   │   ├── update-segment-content.mts (write)
│   │   ├── replace-manifest.mts
│   │   ├── publish-version.mts
│   │   ├── upload-asset.mts    (asset write)
│   │   ├── add-background.mts
│   │   ├── add-character-sprite.mts
│   │   └── delete-script.mts   (destructive)
│   └── __tests__/
│       ├── op-kit.test.mts        (25 tests)
│       └── lint-manifest.test.mts (14 tests)
└── routes/mcp.mts              ← 281 lines（迁移前 1380 行，−1099）
```

## mcp.mts 瘦身

| 阶段 | 行数 |
|------|------|
| op-kit bootstrap 前 | 1378 |
| Batch 1 完成（read tools） | 1119 |
| Batch 2 完成（segment/version writes） | 950 |
| Batch 3 完成（asset writes + helper 大清理） | 386 |
| Batch 4 完成（delete_script + 收尾） | 281 |

281 行剩下的全是协议层：
- JSON-RPC 2.0 类型 + dispatcher（initialize / tools/list / tools/call / ping）
- `ToolDef` interface（adapter 共用）
- Elysia route 挂载 + auth + CORS preflight

加新 MCP tool 不需要再碰这个文件。

## op-kit 新增 hotspot

`negentropy --top 3` 在 op-kit 里检出 2 个 medium 级 logic_cohesion 警告：

- `add-character-sprite.mts:77` exec 函数读取了 input 的 20 个字段
- `add-background.mts:63` exec 读取 input 的 15 个字段

原因是 op 的 input 字段多（scriptId / characterId / spriteId /
contentType / imageBase64 / ...），exec 函数自然要全部 read 一遍。这是
*input rich op* 的固有特征，不是真问题。可选缓解：在 exec 顶部统一
`const { ... } = input;` 一次性解构（仍读全部，但对 negentropy 看上去是
读 1 个 `input`）。是否做看后续审美——逻辑等价，且不影响 OpMeta 形状。

## 防腐契约 #8 进展

`delete_script` 是当前唯一 effect='destructive' 的 op，沿用了"两阶段
确认"模式（dry-run 默认 + confirm:true + scriptIdConfirm 校验）。当前
是手写在 op exec 里的，**没有**抽到 withConfirm middleware。

理由：单 op 抽 middleware 是过早抽象。等到第 2-3 个 destructive op 出现
（候选：bulk_delete_versions / restore_archived_version 等），把
公共部分抽到 `op-kit.mts` 的 `withConfirm()` middleware，签名大概像：

```ts
function withConfirm<I, O>(op: Op<I, O>, config: {
  confirmField: keyof I;
  expectField: (input: I) => string;
  dryRun: (input: I, ctx: OpContext) => Promise<{ wouldDo: object; message: string }>;
}): Op<I & { confirm?: boolean }, O | DryRunResult>;
```

防腐契约 #8 的占位符已经在 op-kit.mts 顶部以 `OpMiddleware` 类型留着，
将来加上时不需要破坏现有 op 形状。

## Verification

- `apps/server` `bun --env-file=.env.test test`：181/181 pass，474 expect 调用
- `packages/core` `bun test`：248/248 pass（无影响）
- `bun x tsc --noEmit` apps/server / packages/core 均干净
- 起 server 端到端 smoke test：
  - MCP `tools/list` 返回 14 tool（迁移前同名同形）
  - 各分类至少跑通 1 个 happy path 和 1 个 error path
  - HTTP `GET /api/ops` 列出 14 op，含 `effect: 'destructive'` 标记
  - `delete_script` dry-run 正确返回 wouldDelete preview，confirm 校验
    严格

## Current Top Hotspots（仍非 op-kit 引入）

仍是历史背景：
- `packages/core/src/game-session.mts::anonymous@712`
- `apps/server/src/routes/sessions.mts::open`
- `apps/ui/src/ui/App.tsx::publicInfoToManifest`
- `packages/core/src/schemas.mts`：高 IIE
- `apps/server/src/db/schema.mts`：高 IIE
- 测试 fixture 系：高 SSE

## Follow-up

迁移完成，下一步可以做：

1. **`script.extract_referenced_ids`** —— 复用 `lint-manifest.mts` 的
   提取逻辑，输出"段落正文里出现的所有 ID"raw 集合（不做白名单 diff），
   给 agent 当上游数据用
2. **`script.list_recent_degrades`** —— 接 Langfuse public API 拉最近
   N 小时的 `ir-degrade:*` 事件，按 detail 聚合
3. **`script.propose_manifest_alignment`** —— 自动给出补 manifest 的
   patch（基于 lint findings），dry-run 后由 agent / admin confirm
4. **OpenAPI 自动生成** —— `op.input` / `op.output` 都是 zod，
   `zod-to-openapi` 一行就能产出 swagger.json，给 SDK / dashboard 用
5. **withConfirm middleware** —— 加第 2 个 destructive op 时一并做
6. **前端切到 callOp** —— 现在 ScriptInfoPanel / EditorPage 还在直接
   fetch `/api/scripts/*` 旧 RESTful 路由，可以渐进切到 typed `callOp`
   API（共享 op 定义获得完整类型推断）
