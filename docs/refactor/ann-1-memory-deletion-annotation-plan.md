# ANN.1 Plan — Memory 删除标注数据回流（Step 1）

**Status**: 进行中（2026-04-26 起）
**Feature ID**: `ANN.1`
**上一步设计讨论**: 本会话对话记录（D1=B / D2=i / D3=c）
**完整产品形态**: Figma `6coZ2woF3y0ybLGSoWQZK3`（5 阶段闭环：看到 → 划掉 → 重新构思 → 准/不准 → 反馈分类）；ANN.1 只切前 2 阶段 + commit annotation。

本文件 self-contained：从这里开工，不需要回看历史会话。

---

## 一、恢复上下文指令模板（贴给 Claude 即可开工）

新会话开头复制以下到提示词，Claude 就能完整接上：

```
继续推进 ANN.1 = Memory 删除标注数据回流（Step 1）。
plan 已就绪，写在 docs/refactor/ann-1-memory-deletion-annotation-plan.md，
self-contained。请按下面顺序：

1. 读 AGENTS.md / CLAUDE.md（共用工程规则 + Claude 会话工作流）
2. 读 docs/refactor/ann-1-memory-deletion-annotation-plan.md（本文件，含 plan 全文）
3. 读 packages/core/src/memory/types.mts（Memory 接口契约）
4. 读 packages/core/src/memory/legacy/manager.mts（adapter 范例）
5. 读 packages/core/src/context-assembler.mts:280-291（retrieve 调用点）
6. 读 apps/server/src/operations/op-kit.mts 顶部 8 条防腐契约
7. 读 apps/server/src/operations/script/lint-manifest.mts（op 写法范例）
8. 读 apps/server/drizzle/0014_core_event_envelopes.sql（migration 写法范例）
9. 验环境：ls apps/server/.env apps/server/.env.test 应都是 symlink；
   node_modules 不存在的话先 pnpm install
10. 按 plan 的"实施 Phase"动手；每完成一个 Phase 跑一次 typecheck + test:core，
    通过后 commit。

不要做 Step 2（重生成 + 👍/👎 评分）—— 那是 ANN.2。
ANN.1 单独 commit + 起 dev 环境给用户跑 E2E 验收后再讨论合 main。
```

---

## 二、产品定位（避免 Step 2 混淆）

ANN.1 = **数据回流基础设施**。用户视角：
- 每轮 turn 结束，右上角浮层显示"角色当前记忆"列表（10 条左右）
- 点条目 → 划痕 + 弹理由 chip（人设崩塌 / 记忆错乱 / 逻辑错误 / 其他）
- 选完 → commit annotation + 5s 撤销窗
- **下一轮 retrieve 不会再返回该条目**（D1=B 的体感）
- 但**当前轮已生成的对话不变**（不重生成）

副标题文案明牌"AI 将在下一轮调整"，玩家不会期待立即重写。

ANN.2 后续做：重新构思按钮 + 👍/👎 + 错误分类 → 下一轮 gating。

---

## 三、设计决策（已定）

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| D1 | 标记是否影响后续 retrieve | **B**：filter 下一轮 | 不 filter 等于"按钮是装的"，玩家会停止标注 |
| D2 | retrieve 落库 | **i**：写 `turn_memory_retrievals` 表 | 否则刷新就丢，且历史 turn 看不到 retrieval |
| D3 | 玩家 UI 路线 | **c**：UX 框架降期望（"AI 下一轮调整"文案）| Figma 既有设计；用户接受小 UX gap |
| reason_code | 用 Figma 的 3 + 其他 | `character-broken` / `memory-confused` / `logic-error` / `other` | 玩家友好；Step 2 复用 |
| 撤销窗 | 5s | — | UX 标准时长 |
| mem0 真删 | **否** | 本地 tombstone，cloud 数据完整保留 | 标注价值要求保数据 |

---

## 四、数据模型

### 4.1 migration 0016

```sql
-- 0016: Memory deletion annotation tables.
--
-- ANN.1 第一阶段：把每轮 retrieve 的结果 + 用户标记"删除"的事件持久化，
-- 让标注信号变成可 SQL 聚合 / 导出训练集的数据资产。
--
-- 不改 playthroughs.memory_snapshot —— tombstone 在 retrieve 边界做 filter，
-- 不进 snapshot（避开 legacy/llm-summarizer/mem0 三 adapter snapshot v? → v?
-- 的同步迁移成本）。

CREATE TABLE IF NOT EXISTS "turn_memory_retrievals" (
  "id" text PRIMARY KEY NOT NULL,
  "playthrough_id" text NOT NULL,
  "turn" integer NOT NULL,
  "batch_id" text,                           -- 关联 narrative_entries.batch_id；可能 null（context-assembly 早于 batch 分配）
  "source" text NOT NULL,                    -- 'context-assembly' | 'tool-call'
  "query" text NOT NULL DEFAULT '',          -- retrieve 的 query 串
  "entries" jsonb NOT NULL,                  -- MemoryEntry[]（含 stable id / content / pinned / tags / timestamp）
  "summary" text NOT NULL DEFAULT '',        -- retrieve 返回的 summary 文本（mem0 时是相关记忆 bullet list）
  "meta" jsonb,                              -- adapter meta（mem0 topK / scores / error）
  "retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "turn_memory_retrievals_playthrough_id_fk"
    FOREIGN KEY ("playthrough_id") REFERENCES "playthroughs"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "idx_turn_memory_retrievals_playthrough_turn"
  ON "turn_memory_retrievals" ("playthrough_id", "turn");

CREATE INDEX IF NOT EXISTS "idx_turn_memory_retrievals_batch_id"
  ON "turn_memory_retrievals" ("playthrough_id", "batch_id");


CREATE TABLE IF NOT EXISTS "memory_deletion_annotations" (
  "id" text PRIMARY KEY NOT NULL,
  "turn_memory_retrieval_id" text NOT NULL,
  "playthrough_id" text NOT NULL,            -- 冗余字段，便于聚合查询
  "memory_entry_id" text NOT NULL,           -- 被删 MemoryEntry 的 stable id
  "memory_entry_snapshot" jsonb NOT NULL,    -- 删除时刻完整 MemoryEntry 内容（防源漂移）
  "reason_code" text NOT NULL,               -- 'character-broken' | 'memory-confused' | 'logic-error' | 'other'
  "reason_text" text,                        -- 仅 reason_code='other' 时填
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cancelled_at" timestamp with time zone,   -- 5s 撤销窗内取消填值
  CONSTRAINT "memory_deletion_annotations_retrieval_fk"
    FOREIGN KEY ("turn_memory_retrieval_id") REFERENCES "turn_memory_retrievals"("id") ON DELETE RESTRICT,
  CONSTRAINT "memory_deletion_annotations_playthrough_fk"
    FOREIGN KEY ("playthrough_id") REFERENCES "playthroughs"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "idx_memory_deletion_annotations_playthrough_created"
  ON "memory_deletion_annotations" ("playthrough_id", "created_at");

CREATE INDEX IF NOT EXISTS "idx_memory_deletion_annotations_memory_entry_id"
  ON "memory_deletion_annotations" ("memory_entry_id");

-- 同一 (playthrough, memory_entry_id) 只能有一条 active（cancelled_at IS NULL）的标注。
-- 撤销后允许再次标记。
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_memory_deletion_active"
  ON "memory_deletion_annotations" ("playthrough_id", "memory_entry_id")
  WHERE "cancelled_at" IS NULL;
```

### 4.2 schema.mts 追加

```ts
export const turnMemoryRetrievals = pgTable('turn_memory_retrievals', {
  id: text('id').primaryKey(),
  playthroughId: text('playthrough_id')
    .notNull()
    .references(() => playthroughs.id, { onDelete: 'cascade' }),
  turn: integer('turn').notNull(),
  batchId: text('batch_id'),
  source: text('source').notNull(), // 'context-assembly' | 'tool-call'
  query: text('query').notNull().default(''),
  entries: jsonb('entries').$type<MemoryEntrySnapshot[]>().notNull(),
  summary: text('summary').notNull().default(''),
  meta: jsonb('meta').$type<Record<string, unknown>>(),
  retrievedAt: timestamp('retrieved_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index('idx_turn_memory_retrievals_playthrough_turn').on(table.playthroughId, table.turn),
  index('idx_turn_memory_retrievals_batch_id').on(table.playthroughId, table.batchId),
]);

export const memoryDeletionAnnotations = pgTable('memory_deletion_annotations', {
  id: text('id').primaryKey(),
  turnMemoryRetrievalId: text('turn_memory_retrieval_id')
    .notNull()
    .references(() => turnMemoryRetrievals.id, { onDelete: 'restrict' }),
  playthroughId: text('playthrough_id')
    .notNull()
    .references(() => playthroughs.id, { onDelete: 'cascade' }),
  memoryEntryId: text('memory_entry_id').notNull(),
  memoryEntrySnapshot: jsonb('memory_entry_snapshot').$type<MemoryEntrySnapshot>().notNull(),
  reasonCode: text('reason_code').notNull(), // 'character-broken' | 'memory-confused' | 'logic-error' | 'other'
  reasonText: text('reason_text'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
}, (table) => [
  index('idx_memory_deletion_annotations_playthrough_created').on(table.playthroughId, table.createdAt),
  index('idx_memory_deletion_annotations_memory_entry_id').on(table.memoryEntryId),
]);
```

`MemoryEntrySnapshot` 是 core 层 `MemoryEntry` 的 JSON 兼容子集（id / role / content / pinned / tags / timestamp / turn / tokenCount）。

---

## 五、Core 层改造（packages/core/src/memory/）

### 5.1 新增 `MemoryDeletionFilter` 接口

`packages/core/src/memory/types.mts` 末尾追加：

```ts
/**
 * 删除过滤器 —— adapter 在 retrieve 返回前 / summary 生成时调用 isDeleted(id)
 * 决定该 entry 是否参与本轮 LLM 上下文。
 *
 * Memory adapter 通过 CreateMemoryOptions.deletionFilter 接收。
 * 缺省（undefined）= 不过滤（unit test / 简单场景）。
 *
 * 实现方在生产环境通常是一个查 memory_deletion_annotations 表 + 缓存的 service。
 */
export interface MemoryDeletionFilter {
  /** entry 是否已被用户标记为删除（仅 active annotation 算数，cancelled_at IS NOT NULL 的不算） */
  isDeleted(memoryEntryId: string): boolean | Promise<boolean>;
  /** 一次性返回当前所有 deleted ids，allow adapter 走批量过滤路径优化 */
  listDeleted(): ReadonlyArray<string> | Promise<ReadonlyArray<string>>;
}
```

`CreateMemoryOptions` 增 `deletionFilter?: MemoryDeletionFilter`。

### 5.2 各 adapter 的 retrieve filter

**Legacy** (`legacy/manager.mts`):
- `retrieve()` 末尾对 `entries` 跑 filter：`entries.filter(e => !deletedSet.has(e.id))`
- pinned 摘要也跑 filter（`pinned.filter(e => !deletedSet.has(e.id))`）

**LLMSummarizer**: 同 legacy（共用 reader-based 模式）。

**Mem0** (`mem0/adapter.mts`):
- 把 mem0 search 结果改成填 entries[]（之前是 `entries: []`），id 用 mem0 result id（或 fallback `mem0-${index}`）
- summary bullet list 渲染前过 filter，跳过被删的 result

各 adapter 在 retrieve 开始时调一次 `await deletionFilter.listDeleted()` 拿 set，避免逐项 await。

### 5.3 wrapMemory withRetrievalLogger

新文件 `packages/core/src/memory/retrieval-logger.mts`：

```ts
export interface RetrievalLogContext {
  source: 'context-assembly' | 'tool-call';
  query: string;
  turn: number;
  batchId: string | null;
}

export type RetrievalLogger = (
  ctx: RetrievalLogContext,
  result: MemoryRetrieval,
) => void | Promise<void>;

export function wrapMemoryWithRetrievalLogger(
  inner: Memory,
  options: {
    logger: RetrievalLogger;
    /** 当前轮次提供器（context-assembly 不传 turn，靠 closure 拿） */
    getTurn: () => number;
    /** 当前 batchId 提供器（context-assembly 时 null）*/
    getBatchId: () => string | null;
    /** 默认 source；调用方可在调用前覆盖（query_memory tool 时设 'tool-call'） */
    defaultSource?: 'context-assembly' | 'tool-call';
  },
): Memory;
```

实现细节：返回一个 Proxy / 对象 spreading inner method，但 `retrieve()` 包一层把结果 fire-and-forget 传给 logger。**logger 失败不能阻塞 retrieve**（catch + console.error）。

### 5.4 不改 game-session.ts 的退路

把 logger / filter 都挂在 createMemory 的 options 上传入。`apps/server/src/session-manager.mts` 在构造 `GameSessionConfig` 时塞这两个 callback —— 不改 core 层任何调用方代码。

---

## 六、Server 层改造

### 6.1 services

**`apps/server/src/services/memory-retrieval-service.mts`**：
- `recordRetrieval({ playthroughId, turn, batchId, source, query, entries, summary, meta }): Promise<{ id }>` —— 写一行 `turn_memory_retrievals`
- `listByPlaythrough(playthroughId, opts?: { turn?: number; limit?: number }): Promise<TurnMemoryRetrievalRow[]>`
- `getById(id): Promise<TurnMemoryRetrievalRow | null>`

**`apps/server/src/services/memory-annotation-service.mts`**：
- `markDeleted({ retrievalId, memoryEntryId, reasonCode, reasonText? }): Promise<{ id, createdAt }>` —— 写 `memory_deletion_annotations`，先校验 retrievalId 存在 + entry 在 retrieval.entries 里（不在则报 INVALID_INPUT）
- `cancel(annotationId): Promise<void>` —— 检查 `now - createdAt < 5000ms`，否则报 CONFLICT；满足则 `UPDATE SET cancelled_at = now()`
- `listActiveByPlaythrough(playthroughId): Promise<{ memoryEntryId: string; reasonCode: string }[]>` —— 给 Memory deletion filter 用，cached 5s

### 6.2 ops（3 个）

| op name | auth | effect | 简述 |
|---|---|---|---|
| `memory.list_turn_retrievals` | any | safe | 列某 playthrough 的 retrieval（默认最近 N turn） |
| `memory.mark_deleted` | any | mutating | 标记一条 entry 为删除 |
| `memory.cancel_deletion` | any | mutating | 撤销一条 annotation（5s 内） |

放在新目录 `apps/server/src/operations/memory/`，registry.mts 加 `import` + push 到 `ALL_OPS`。

auth 为什么是 'any' 而不是 'registered'：anonymous 玩家也能标，annotation 仍归到 playthrough_id（playthrough 记着 user_id）。后续做数据导出时可按 user 维度过滤掉低质量来源。

### 6.3 session-manager 接线

`apps/server/src/session-manager.mts` 的 `buildConfig()`：
- 在 createMemory（被 GameSession 内部调）的入参里加 `deletionFilter`
- 但 createMemory 的入参是 `CreateMemoryOptions`，由 game-session 在 `initializeCore` 里调用 —— 所以要让 server 把 filter 通过 `GameSessionConfig` 传给 game-session，再透传给 createMemory

**方案**：
- 在 `GameSessionConfig` 加 `memoryDeletionFilter?: MemoryDeletionFilter`
- `game-session.initializeCore` 把 `config.memoryDeletionFilter` 透传给 `createMemory({ ..., deletionFilter })`
- session-manager.buildConfig 构造一个 `MemoryDeletionFilter` 实例（封装 memory-annotation-service 的 listActiveByPlaythrough）

retrieval logger 走类似路径 —— 加 `GameSessionConfig.memoryRetrievalLogger?: RetrievalLogger`。但 logger 需要拿到当前 batchId / turn，所以由 game-session 包一层 wrapMemoryWithRetrievalLogger，把 closure 引用 this.currentTurn / this.currentStepBatchId 传进去。

### 6.4 WebSocket 广播

新 core event 类型 `memory-retrieval`（在 packages/core/src/game-session.mts 的 CoreEvent union 里加）：

```ts
| {
    type: 'memory-retrieval';
    turn: number;
    retrievalId: string;
    source: 'context-assembly' | 'tool-call';
    query: string;
    entries: Array<{ id: string; role: string; content: string; pinned?: boolean }>;
    summary: string;
  }
```

retrieval logger 在写 DB 后 publish 这个 event；ws-core-event-sink 翻译成 WS message 发给客户端。

### 6.5 Tracing

`apps/server/src/tracing.mts` 加：
- `recordMemoryRetrieval(turn, source, entryCount)` → langfuse event `memory-retrieval`
- `recordMemoryDeletion({ retrievalId, memoryEntryId, reasonCode })` → langfuse event `memory-deletion`

memory-annotation-service 在 markDeleted / cancel 后调对应 tracing。

---

## 七、Frontend 层

### 7.1 game-store 扩展

`apps/ui/src/stores/game-store.mts` 加：

```ts
interface MemoryRetrievalView {
  id: string;
  turn: number;
  source: 'context-assembly' | 'tool-call';
  query: string;
  entries: Array<{ id: string; role: string; content: string; pinned?: boolean }>;
  summary: string;
}

interface MemoryDeletionView {
  annotationId: string;
  memoryEntryId: string;
  reasonCode: 'character-broken' | 'memory-confused' | 'logic-error' | 'other';
  reasonText?: string;
  createdAt: string;
  cancellable: boolean; // 5s 内
}

// state additions:
currentTurnRetrievals: MemoryRetrievalView[];
memoryDeletions: Record<string, MemoryDeletionView>; // by memoryEntryId

// actions:
appendRetrieval(retrieval: MemoryRetrievalView): void;
markMemoryDeleted(input): Promise<void>; // POST /api/ops/memory.mark_deleted
cancelMemoryDeletion(annotationId): Promise<void>;
clearRetrievalsForNewTurn(turn): void;
```

新 turn 开始时清空 `currentTurnRetrievals`（保证 panel 显示当前轮的）。

### 7.2 WS 客户端

`apps/ui/src/stores/ws-message-handlers.mts` 加 `memory-retrieval` 类型 case → `appendRetrieval`。

### 7.3 MemoryPanel 组件

新文件 `apps/ui/src/ui/play/MemoryPanel.tsx`：

- 浮在右上角（absolute positioning + Tailwind）
- 标题 ">> 角色当前记忆 / memories"
- 副标题 "⚠ 点击划掉混乱记忆 · AI 将在下一轮调整"
- 列出 `currentTurnRetrievals[].entries`（去重，merge by entry.id；context-assembly + tool-call 都展示）
- 每条显示 `[N] ${content.slice(0, 30)}...`
- 点击未删条目：
  - 划痕 CSS 动画（line-through + 半秒过渡）
  - 弹出 inline chip 行：`[人设崩塌] [记忆错乱] [逻辑错误] [其他...]`
  - 选择 chip → 调 `markMemoryDeleted` → 5s toast 显示"已记录 · 撤销"
  - "其他" → 单行 input 让玩家填理由（短，可选）
- 已删条目：灰色 + 标签"已忘掉 · ${reason 中文}"
- 撤销窗：5s 内可点 toast 撤销

紧凑实现策略：第一版只用 Tailwind 内联 + 1 个组件文件，不引 shadcn dialog —— 减少 churn。

### 7.4 集成到 PlayPage / VNStageContainer

在 `apps/ui/src/ui/play/vn/VNStageContainer.tsx` JSX 末尾插入 `<MemoryPanel />`，绝对定位浮在 stage 右上。
EditorMode 也显示（admin 自己 dogfood）。

---

## 八、实施 Phase（按依赖顺序）

每个 Phase 完成后跑 `pnpm typecheck` + `pnpm test:core` + `cd apps/server && bun test`，绿了 commit。

### Phase 0：plan + feature_list（本步）
- 写 plan 到 docs/refactor/
- feature_list.json 加 ANN.1 entry

### Phase 2a：DB schema
- 写 `apps/server/drizzle/0016_memory_deletion_annotations.sql`
- schema.mts 加 2 表 + 类型导出
- `db:check` 干净
- commit

### Phase 2b：services
- `services/memory-retrieval-service.mts`
- `services/memory-annotation-service.mts`
- 单测覆盖：写 retrieval / 写 annotation / 撤销在 5s 内 / 撤销在 5s 后失败 / unique active constraint
- commit

### Phase 2c：ops + registry
- `operations/memory/list-turn-retrievals.mts`
- `operations/memory/mark-deleted.mts`
- `operations/memory/cancel-deletion.mts`
- registry.mts 加导入 + push
- 单测：3 个 op input/output schema parse
- commit

### Phase 3：core memory layer
- `packages/core/src/memory/types.mts` 加 `MemoryDeletionFilter` 接口 + `CreateMemoryOptions.deletionFilter`
- `packages/core/src/memory/retrieval-logger.mts` 新文件
- 各 adapter retrieve 加 filter 逻辑（legacy / llm-summarizer / mem0）
- 单测：3 adapter 在 deletionFilter 提供 tombstone 时正确过滤；retrieval-logger 在 retrieve 后调 callback
- commit

### Phase 3b：session-manager 接线
- `GameSessionConfig` 加 `memoryDeletionFilter` + `memoryRetrievalLogger`
- `game-session.initializeCore` 透传 filter；wrap memory with logger
- session-manager.buildConfig 构造两个 callback（封装 services + 当前 turn / batchId 闭包）
- commit

### Phase 4a：WS 广播
- `CoreEvent` union 加 `memory-retrieval` 类型
- `ws-core-event-sink.mts` 加 case → 翻译成 WS message
- retrieval-logger 实现里 publishCoreEvent('memory-retrieval', ...)
- commit

### Phase 4b：game-store
- 加 state + actions
- ws-message-handlers 加 'memory-retrieval' case
- 单测：appendRetrieval 去重；clearRetrievalsForNewTurn 清空
- commit

### Phase 4c：MemoryPanel UI
- 写组件
- 集成进 VNStageContainer
- 起 dev 跑 E2E 看真实显示
- commit

### Phase 5：E2E 验证
- 起 server + dev
- 浏览器：
  - 创建新 playthrough → 走 1 轮 → 验证 panel 显示 entries
  - 标 1 条（选 reason） → 验证 toast + 划痕
  - 5s 内点撤销 → 验证回复
  - 再标 1 条不撤销 → 走下一轮 → 验证 panel 不再显示该 entry
  - 查 DB：`SELECT * FROM memory_deletion_annotations WHERE playthrough_id = ?` 应该有 1 行
- 截图给用户

---

## 九、验证标准（feature_list.json 的 verify 字段）

- 单测：3 adapter retrieve filter 正确（unit）；annotation cancel 5s 边界（unit）；ops schema parse（unit）
- 集成：server 起来，端到端跑 1 个 playthrough，标 1 条 → DB 有行 + Langfuse 有 event + 下一轮 retrieve 不返回该 entry
- 浏览器：MemoryPanel 显示 / 划痕动画 / 5s 撤销窗 / 下一轮自动消失

---

## 十、Step 2 hand-off 预告（不在本期）

ANN.2 上线时只需要：

1. `narrative_entries` 加 `superseded_by_batch_id` 字段（migration 0017）
2. 新 op `playthrough.regenerate_current_turn`（soft-mark batch + 重跑 generate）
3. `MemoryPanel` 加 "重新构思" 按钮（标完后出现）
4. 新表 `turn_quality_ratings`（👍/👎 + 错误分类 + 关联 [N] 索引 + 自由文本）+ 配套 op + UI

ANN.1 schema 不需要改一字。

---

## 十一、不在本期范围

- 重生成（ANN.2）
- 👍/👎 评分（ANN.2）
- "下一轮" gating（ANN.2）
- mem0 cloud 真删（永远不做）
- 批量删除（按需补）
- 多语言 reason 文案（先中文）
- 编辑器 EditorDebugPanel 改造（player UI 优先）
