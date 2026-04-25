# Op A Plan — `script.extract_referenced_ids`

**Status**: plan ready, **未开工**（2026-04-25）
**Feature ID**: `OP.5`
**上一层 roadmap**: `docs/refactor/op-kit-roadmap.md`

本文件 self-contained：从这里开工，不需要回看历史会话。

---

## 一、恢复上下文指令模板（贴给 Claude 即可开工）

新会话开头复制以下到提示词，Claude 就能完整接上：

```
继续推进 op-kit 这条线的 OP.5 = Op A: script.extract_referenced_ids。
plan 已就绪，写在 docs/refactor/op-a-extract-referenced-ids-plan.md，
self-contained。请按下面顺序：

1. 读 AGENTS.md / CLAUDE.md（共用工程规则 + Claude 会话工作流）
2. 读 docs/refactor/op-a-extract-referenced-ids-plan.md（本文件，含 plan 全文）
3. 读 docs/refactor/op-kit-roadmap.md（上一层背景：op-kit 这条线在做什么）
4. 读 apps/server/src/operations/op-kit.mts 顶部 8 条防腐契约
5. 读 apps/server/src/operations/script/lint-manifest.mts（op 写法范例 + Op A 复用 _internal.extractFromSegment）
6. 读 apps/server/src/operations/registry.mts（要在这里 push 新 op）
7. 读 apps/server/src/operations/script/_shared.mts（resolveTargetVersion 复用）
8. 跑 ~/.cargo/bin/negentropy --version 确认能用（PATH 没含 ~/.cargo/bin）
9. 验环境：ls apps/server/.env apps/server/.env.test 应都是 symlink；
   node_modules 不存在的话先 pnpm install
10. 按 plan 的"执行步骤"动手；每完成一个 verify 步给我汇报

不要跳到 OP.6 / OP.7。Op A 单独 commit + push 后停下来等下一步指示。
```

---

## 二、Pre-flight Checklist（开工前 5 分钟内确认）

| # | 检查项 | 期望值 | 出错怎么办 |
|---|--------|--------|-----------|
| 1 | `git rev-parse HEAD` | 至少 `cf3bbab`（含 setup:env）；理想是 main 最新 | `git fetch origin main && git checkout main && git pull --ff-only`（在主仓库做，不是 worktree） |
| 2 | `git status` | clean（没未提交改动） | 检查是不是上次会话残留 |
| 3 | `ls apps/server/.env apps/server/.env.test` | 两个都是 `lrwxr-xr-x` 软链 | `pnpm setup:env` |
| 4 | `ls node_modules` | 存在 | `pnpm install` |
| 5 | `~/.cargo/bin/negentropy --version` | `negentropy 0.1.0` | 把 `~/.cargo/bin` 加进 zshrc PATH |
| 6 | `cd apps/server && bun --env-file=.env.test test --rerun-each 0 2>&1 \| tail -5` | 181/181 pass | 看 .env.test 的 DATABASE_URL 是否真的指向 `*test*` 库 |
| 7 | `cd packages/core && bun test 2>&1 \| tail -5` | 248/248 pass | 同上，单测一般不依赖 env |

全过 → 直接进"执行步骤"。

---

## 三、Op 设计（schema + meta 完整定义）

### Op meta

| 字段 | 值 |
|------|-----|
| `name` | `script.extract_referenced_ids` |
| `category` | `script` |
| `effect` | `safe`（read-only） |
| `auth` | `admin`（与 `script.lint_manifest` 对齐） |
| `mcpName` | **不设**（新 op，MCP 自动剥前缀 → `extract_referenced_ids`） |
| `uiLabel` | `'抽取剧本引用 ID'` |

### Description（写到 `defineOp` 里）

```
'抽取剧本所有段落正文里出现过的 background / character / (character, mood)
ID 集合（去重 + 字典序）。纯抽取不做 manifest 白名单 diff —— 是 ' +
'script.lint_manifest 的子集，给修复 agent 当上游数据：知道剧本实际用了什么 ' +
'再决定怎么补 manifest。'
```

### Input schema

```ts
export const extractReferencedIdsInput = z.object({
  scriptId: z.string().describe('要抽 ID 的剧本 id（见 list_scripts）'),
  versionId: z
    .string()
    .optional()
    .describe('可选：指定版本；不传则取 published，无则取最新 draft'),
});
```

### Output schema

```ts
export const extractReferencedIdsOutput = z.object({
  scriptId: z.string(),
  versionId: z.string(),
  versionNumber: z.number().int(),
  protocolVersion: z.enum(['v1-tool-call', 'v2-declarative-visual']),
  /** 段落里出现过的所有 background id（去重 + 字典序） */
  backgrounds: z.array(z.string()),
  /** 段落里出现过的所有 character id（去重 + 字典序） */
  characters: z.array(z.string()),
  /**
   * (character, mood) 二元组（去重 + 按 character 然后 mood 字典序）
   * 注意字段名 character/mood，不是 lint-manifest 内部的 parentId/id
   */
  emotions: z.array(
    z.object({
      character: z.string(),
      mood: z.string(),
    }),
  ),
});
```

---

## 四、文件改动

| 类型 | 路径 |
|------|------|
| 新增 | `apps/server/src/operations/script/extract-referenced-ids.mts` |
| 新增 | `apps/server/src/operations/__tests__/extract-referenced-ids.test.mts` |
| 修改 | `apps/server/src/operations/registry.mts`（import + 加到 ALL_OPS 的 read 段，紧跟 `lintManifestOp` 后） |

**不动** `lint-manifest.mts` —— 只 import 它已 export 的 `_internal.extractFromSegment`。

### registry.mts diff 形态

```ts
// import 块
import { lintManifestOp } from '#internal/operations/script/lint-manifest';
+ import { extractReferencedIdsOp } from '#internal/operations/script/extract-referenced-ids';

// ALL_OPS 列表
  // script.* —— 只读
  ...
  lintManifestOp,
+ extractReferencedIdsOp,
  // script.* —— 写
  ...
```

---

## 五、实现要点

1. **复用 `_internal.extractFromSegment`** (`lint-manifest.mts:401`)：扫 segment 正文，抽 v1/v2 两套语法。
2. **复用 `_shared.mts` 的 `resolveTargetVersion`**：published-fallback / 跨 script versionId 校验，与 lint-manifest 同 pattern。
3. **拆纯函数 `extractAllRefs(manifest)`**：遍历 `chapters[].segments[]` + 调 `extractFromSegment` + 去重 + 排序。从本文件 `_internal` 命名 export，单测对它直测，不走 service。

```ts
// 签名草稿
export function extractAllRefs(manifest: ScriptManifest): {
  protocolVersion: 'v1-tool-call' | 'v2-declarative-visual';
  backgrounds: string[];
  characters: string[];
  emotions: { character: string; mood: string }[];
}
```

4. **字段重命名**：`extractFromSegment` 输出 `{ id: mood, parentId: char }`，本 op output 用 `{ character, mood }`。在 `extractAllRefs` 内做映射。
5. **去重 key**：`emotions` 用 `${char}|${mood}` 作 dedup key（防止"不同 char 的同名 mood"被误合并，单测 #5 覆盖）。
6. **输出排序**：字典序：
   - `backgrounds.sort()` / `characters.sort()`（默认字符串字典序）
   - `emotions.sort((a, b) => a.character.localeCompare(b.character) || a.mood.localeCompare(b.mood))`

### exec 函数骨架

```ts
async exec(input, _ctx) {
  const { scriptId, versionId } = input;

  const script = await scriptService.getById(scriptId);
  if (!script) {
    throw new OpError('NOT_FOUND', `Script not found: ${scriptId}`);
  }

  const version = await resolveTargetVersion(scriptId, versionId);
  const refs = extractAllRefs(version.manifest);

  return {
    scriptId,
    versionId: version.id,
    versionNumber: version.versionNumber,
    protocolVersion: refs.protocolVersion,
    backgrounds: refs.backgrounds,
    characters: refs.characters,
    emotions: refs.emotions,
  };
}
```

---

## 六、单测（7 条，参考 lint-manifest.test.mts 风格）

走 `_internal.extractAllRefs` 不依赖 DB。复用 `lint-manifest.test.mts` 里的 `makeManifest` helper —— 先 copy 简化版到测试文件，等第三个测试文件重复时再抽 fixture（不要现在就过早抽象）。

| # | 名称 | 验证点 |
|---|------|--------|
| 1 | v2 协议剧本能抽 background/character/emotion | happy path：`<background scene="x" />` + `<sprite char="y" mood="z" />` 都进 output |
| 2 | v1 协议剧本（change_scene/change_sprite）能抽 | 协议覆盖：v1 工具调用范例文本里的 ID 能抽出来 |
| 3 | 同 background id 在两段重复 → 只列一次 | string dedup |
| 4 | 同 (char, mood) 在多段重复 → 只列一次 | tuple dedup |
| 5 | 不同 character 的同名 mood 不去重 | (sakuya, smile) + (karina, smile) 两条都在 |
| 6 | 跨多 chapter 累积 | 段落分散在 ch1/ch2，全部进 output |
| 7 | 空 segment / 空 manifest → 三数组皆 [] | 边界：`segmentContent: ''` 和 `chapters: []` 两个子 case |

---

## 七、执行步骤

按顺序，每步 verify pass 才进下一步。

### 1. 写代码
- 新增 `extract-referenced-ids.mts`（schema + extractAllRefs + defineOp + _internal export）
- 新增 `__tests__/extract-referenced-ids.test.mts`（7 条单测）
- 改 `registry.mts`（import + push）

### 2. tsc 干净
```bash
pnpm typecheck
# 期望：apps/server + packages/core + apps/ui + packages/specification 全过
```

### 3. 单测
```bash
cd apps/server && bun test extract-referenced-ids
# 期望：7/7 pass

# 如果 _internal 纯函数测试不依赖 DB，下一行就不用 --env-file：
cd apps/server && bun test 2>&1 | tail -5
# 期望：188/188 pass（之前 181 + 新 7）

# 如果上一步报 DB 连不上，回退用：
cd apps/server && bun --env-file=.env.test test 2>&1 | tail -5
```

### 4. Smoke test（按 CLAUDE.md 第三·五节顺序）
```bash
# Terminal 1：起 server，等 health 200
cd apps/server && bun --env-file=.env.test run src/index.mts &
until curl -sf http://localhost:3001/health > /dev/null; do sleep 0.3; done

# Terminal 2：MCP tools/list 看 extract_referenced_ids 出现
curl -s -X POST http://localhost:3001/api/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin token>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | jq '.result.tools[] | select(.name == "extract_referenced_ids")'

# Terminal 2：HTTP /api/ops 也应该列 script.extract_referenced_ids
curl -s http://localhost:3001/api/ops | jq '.[] | select(.name == "script.extract_referenced_ids")'

# Terminal 2：happy path（用一个真实 scriptId）
curl -s -X POST http://localhost:3001/api/ops/script.extract_referenced_ids \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin token>" \
  -d '{"scriptId":"<some-script-id>"}' | jq

# Terminal 2：error path —— 不存在的 scriptId 应该 NOT_FOUND
curl -s -X POST http://localhost:3001/api/ops/script.extract_referenced_ids \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <admin token>" \
  -d '{"scriptId":"nonexistent"}' | jq
# 期望：{ "error": { "code": "NOT_FOUND", ... } }
```

### 5. Negentropy
```bash
~/.cargo/bin/negentropy analyze . --format table --fail-on none --top 5
# 期望：top 5 hotspot 不变（add-character-sprite=20 / add-background=15 等历史 hotspot 在前）
# 新 op 的 exec 函数读取的 input 字段少（scriptId + versionId），不会进 logic_cohesion 排行
# 如果新 hotspot 出现，写报告 docs/refactor/negentropy-2026-04-25-op-a.md（参考 op-kit-bootstrap.md 风格）
```

### 6. Commit + push + ff merge

```bash
# commit msg 风格对齐（参考 git log --oneline -5）
git add apps/server/src/operations/script/extract-referenced-ids.mts \
        apps/server/src/operations/__tests__/extract-referenced-ids.test.mts \
        apps/server/src/operations/registry.mts
git commit -m "feat(operations): 新增 script.extract_referenced_ids op（lint 子集，纯抽取）"

# push 当前分支
git push origin <current-branch>

# 主仓库 fast-forward main + push（在主仓库目录跑）
git -C /Users/kawowl/project/github.com/KawOwl/IVNEditor fetch origin
git -C /Users/kawowl/project/github.com/KawOwl/IVNEditor merge --ff-only <current-branch>
git -C /Users/kawowl/project/github.com/KawOwl/IVNEditor push origin main
```

完成。停下来等下一步（OP.6 / OP.7 或别的指示）。

---

## 八、为什么 A 先做（不直接进 B / C）

1. **依赖关系**：C（`propose_manifest_alignment`）需要"知道剧本实际引用了什么"才能 propose 补什么 → A 是 C 的纯函数上游。
2. **复杂度递增**：A 复用现成 `extractFromSegment` 几乎零新代码；B 接 Langfuse 外网 API 要先 curl 探数据形状；C 业务逻辑最复杂，可测纯函数要拆到 `_shared.mts`。
3. **独立可用**：A 自己就有用 —— agent 想知道"这个剧本到底用了哪些 ID"时直接调，不必非走 lint diff 路径。

---

## 九、防止踩坑（来自 op-kit 14 个 op 迁移经验）

- **不要**在 `op-kit.mts` 里 import elysia / hono / 任何框架（防腐 #1 —— 但 Op A 不动 op-kit.mts）
- **不要** `throw new Error(...)`，永远 `throw new OpError(code, ...)`（防腐 #3）
- **不要**把 Zod schema 内联到 `defineOp` 里，命名 export（防腐 #4）
- **不要**写相对路径 `'../op-kit.mts'`，用 `'#internal/operations/op-kit'`（tsconfig 不开 `allowImportingTsExtensions`）
- **改 server routes / plugin 链必须真起 server smoke check**，tsc + bun test 不够 —— Op A 只加 op 不改 routes，理论上不需要 smoke 也行，但养成习惯都做
- 单 op 的 commit message 风格参照最近 5 条：`feat(operations): <动词> <op 名>（<一句话说明>）`

---

## 十、已知风险 / 待定细节

1. **`extractAllRefs` 单测是否真的不依赖 DB**：plan 假设走 `_internal` 纯函数 path（参考 lint-manifest.test.mts），但实际跑之前不能 100% 确认。如果 `bun test extract-referenced-ids` 没 `--env-file=.env.test` 报 DB 错，加回去就行。
2. **HTTP smoke 用什么 admin token**：当前不知道 `apps/server/.env` 有没有 `ADMIN_TOKEN`，如果没有要看 auth-identity 实现走另外的 auth path。MCP smoke 同理。建议 smoke 前先 grep 一下当前 admin auth 怎么挂的。
3. **`scriptService.getById` vs `resolveTargetVersion`**：`resolveTargetVersion` 已经会校验"versionId 属于该 script"，但如果 scriptId 不存在又没传 versionId，它走 `listByScript` 返回空数组也能抛 NOT_FOUND。是否需要前置 `getById` 检查？lint-manifest 是先 `getById` 再 `resolveTargetVersion`，Op A 沿用这个 pattern 即可（双重检查无害，error message 更准确）。

---

## 十一、Out-of-scope（明确不做）

- **OP.6 (Op B) / OP.7 (Op C)**：单独的 feature 单独的 plan
- **前端 UI 调用**：当前没有 UI 入口，agent / curl / MCP 客户端用即可
- **`lint-manifest.mts` 重构**：保持原样，只 import `_internal`
- **`extractFromSegment` 返回类型重命名为 `{ character, mood }`**：那是改 lint-manifest 内部表示，影响面比 Op A 大，留给将来如果两边都需要再做
