# Memory Refactor v2 —— adapter 降级为 cache 层

> Status: **实施中**（2026-04-23）
> 触发: `architecture-alignment.md` 里对"双写偏离"的收敛
> 前置: PR-M1（NarrativeHistoryReader + messages-builder 已上线）
> 后续: legacy memory snapshot 的 entries 字段最终下线

---

## 目标

让 memory adapter **不再自持有对话 entries 副本**。通过 PR-M1 落地的
`NarrativeHistoryReader` 从 canonical `narrative_entries` 读数据，自己只维护：

- `summaries`（派生：压缩得到的摘要）
- `pinned`（独立：来自 `pin_memory` tool 的重要记忆）
- 必要的 cursor / watermark（比如"已压缩到哪条 orderIdx"）

完成后的架构对齐 `architecture-alignment.md` 的理想图：

```
narrative_entries (canonical, append-only)
     ↓  NarrativeHistoryReader
Memory Adapter
   内部: summaries / pinned / compressedUpTo
   不再: state.entries
```

---

## 不变量（public API 不动）

| Memory 接口方法 | 行为是否变 |
|---|---|
| `appendTurn(params)` | 签名不变；legacy / llm-summarizer 内部变成最小化（只用来 flush pending）；mem0 继续 flush 到云端 |
| `pin(content, tags)` | 不变（进 state.pinned） |
| `retrieve(query)` | 签名不变；内部改走 reader 读 entries + 结合 summaries/pinned |
| `getRecentAsMessages({budget})` | 签名不变；内部改走 reader 读最近 N |
| `maybeCompact()` | 签名不变；compress 时从 reader 拉区间内 entries，不再查 state.entries |
| `snapshot()` | **格式变**：legacy-v1 → legacy-v2（去掉 entries 字段） |
| `restore(snap)` | 兼容 v1（接收但只 extract summaries + pinned=true 的 entries）+ 认 v2 |
| `reset()` | 行为不变 |

**调用方不改**（game-session / context-assembler / tool-executor 一行都不用动）。

---

## 数据模型变化

### 1. MemoryEntry 来源

当前：adapter 内部生成 `MemoryEntry` 对象（`{id, turn, role, content, tokenCount, ...}`），存进 `state.entries`。

新：从 `narrative_entries` 的 `NarrativeEntry` 派生。加一个映射工具：

```ts
// src/core/memory/narrative-entry-mapping.ts

/**
 * 把 canonical 的 NarrativeEntry 映射成 memory 层的 MemoryEntry。
 * 跳过对 LLM 上下文无意义的类型（tool_call 不进 memory）。
 */
export function narrativeToMemoryEntry(e: NarrativeEntry): MemoryEntry | null {
  switch (e.kind) {
    case 'narrative':
      return {
        id: e.id,
        turn: 0,                          // 不从 narrative_entries 推导 turn；recency 用 orderIdx 顺序
        role: 'generate',
        content: e.content,
        tokenCount: estimateTokens(e.content),
        timestamp: e.createdAt.getTime(),
        pinned: false,
      };
    case 'player_input':
      return {
        id: e.id,
        turn: 0,
        role: 'receive',
        content: e.content,
        tokenCount: estimateTokens(e.content),
        timestamp: e.createdAt.getTime(),
        pinned: false,
      };
    case 'signal_input':
      // 跳过：hint/choices 的副作用已通过 narrative context 传达（上条 narrative
      // 通常包含"请选择"之类的自然语言提示）；LLM 下轮不需要看到结构化 signal
      // 事件也能理解。如果将来发现 LLM 丢失上下文，可以改成返回 system role entry。
      return null;
    case 'tool_call':
      // 同上：update_state / change_scene 等工具的副作用已体现在 stateVars /
      // currentScene 快照里，LLM 下轮 assembleContext 能看到。不进 memory。
      return null;
  }
}
```

### 2. Legacy / LLMSummarizer 内部状态瘦身

**旧**：
```ts
interface State {
  entries: MemoryEntry[];    // ← 和 narrative_entries 重复
  summaries: string[];
}
```

**新**：
```ts
interface State {
  summaries: string[];
  /**
   * pin_memory tool 的显式高亮条目。不在 narrative_entries 里
   * （pin_memory 的语义是"记在记忆侧"，不是叙事事件）。
   */
  pinned: MemoryEntry[];
  /**
   * 最后一次压缩覆盖到哪条 orderIdx。下一次压缩从 compressedUpTo+1 开始。
   * 新建 playthrough 时为 -1，restore v1 时从 summaries.length 推断（已压 = summaries 长度 × 某个常数，不精确兜底）。
   */
  compressedUpTo: number;
}
```

### 3. Snapshot 格式

**Legacy**：
- v1（旧）：`{kind:'legacy-v1', entries, summaries}` —— restore 时只取 summaries + 从 entries 提取 pinned
- v2（新）：`{kind:'legacy-v2', summaries, pinned, compressedUpTo}` —— entries 字段消失

**LLMSummarizer**：类似，v1 → v2

**Mem0**：不动（recentEntries 是本地 cache，不属于"entries 副本"问题）

---

## 实施步骤

### Step 1 — Memory interface 接入 reader

- `MemoryScope` / `CreateMemoryOptions` 加 `reader?: NarrativeHistoryReader`
- `factory.createMemory(options)` 把 reader 透传给 adapter 构造器
- 各 adapter constructor 加 `reader` 参数（optional，老单测不传也能实例化）

### Step 2 — 映射工具

- 新文件 `src/core/memory/narrative-entry-mapping.ts` + 单元测试

### Step 3 — LegacyMemory 改造

- 删 `state.entries`，加 `state.pinned` + `state.compressedUpTo`
- `appendTurn`：变成 no-op（或只 log / 通知 maybeCompact 知道有新数据），不再写入 state
- `pin`：进 `state.pinned`（和以前 entries 里 pinned=true 的条目分离出来）
- `retrieve`：
  - reader 存在时：`reader.readRecent({limit:100})` 拿近期 entries → 映射 + keyword match
  - reader 不存在时：保守返回空 entries（单测场景）
  - summary = state.summaries + state.pinned（格式不变）
- `getRecentAsMessages`：
  - reader 存在时：`reader.readRecent({limit: recencyWindow})` → 映射 → role 翻译 + budget cap
  - reader 不存在时：返回空 messages（单测）
- `maybeCompact`：
  - 读 reader.readRange({fromOrderIdx: compressedUpTo+1})
  - 如果 token 超阈值：调 compressFn 得到 summary，push 到 state.summaries，更新 compressedUpTo
- `snapshot`：v2 格式
- `restore`：兼容 v1（提取 summaries + 从 entries 中的 pinned=true 的条目进 pinned）+ v2

### Step 4 — LLMSummarizerMemory 改造

同 Legacy 模式（代码风格和 LegacyMemory 对齐）。

### Step 5 — Mem0Memory 最小改

- constructor 接受 reader（但内部可以不用 —— 它本来就不存 entries 副本）
- 保留 local `recentEntries` 窗口（mem0 云端检索不保序，本地缓存 getRecentAsMessages 用）
- 其他不变

### Step 6 — session-manager 注入 reader

```ts
// server/src/session-manager.ts
const reader = createNarrativeHistoryReader(playthroughId);
const memory = await createMemory({
  scope: {...},
  config: manifest.memoryConfig,
  llmClient,
  mem0ApiKey: process.env.MEM0_API_KEY,
  reader,  // ← 新增
});
```

### Step 7 — 测试

- `narrative-entry-mapping.test.ts`：映射规则验证
- `legacy-memory.test.ts`（新）：基础 smoke，验证 reader-based retrieve / getRecentAsMessages
- 保持 server tests 全绿（persistence 层不变，只 memory 层重构）

### Step 8 — 文档更新

- `architecture-alignment.md` 的"Memory Refactor v2"章节从"进行中" → "已完成"
- `memory-refactor.md`（老文档）加 note：已被 v2 取代
- PROGRESS.md 加新里程碑

---

## 风险 / 兜底

### R1: reader 不可用时的 legacy 单元测试

某些 memory 单测可能直接 `new LegacyMemory(config, compressFn)` 而不传 reader。
处理：reader 参数 optional，不传时 retrieve/getRecentAsMessages 返回空 —— 保守但 not crash。

### R2: restore v1 snapshot 的 pinned 丢失

老 snapshot 里 pinned 是以 `entries[i].pinned=true` 形式存在。restore 必须抓住并
迁到新 state.pinned。不迁会导致：
- 老 playthrough 重连后 "_engine_memory" section 丢掉 pinned 标记
- LLM 忘记重要记忆

迁移逻辑：
```ts
if (snap.kind === 'legacy-v1') {
  const entries = (snap.entries ?? []) as MemoryEntry[];
  state.pinned = entries.filter(e => e.pinned);
  state.summaries = (snap.summaries ?? []) as string[];
  state.compressedUpTo = -1; // 保守兜底：不丢失已有 summaries，但新压缩起点不准
}
```

### R3: compressedUpTo 冷启动不准

对 v1 restored 的 playthrough，compressedUpTo=-1 意味着"从头压缩"。但 summaries
里已经有东西了 —— 会双重压缩老段落。

简单兜底：compressedUpTo 置为 "max(0, readRecent()[0].orderIdx - 1)"，即"至少
不把当前缓存窗口的内容重压"。精度够，实际影响小（少量双重摘要，LLM 能忍受）。

### R4: narrative_entries kind 扩展后 mapping 要更新

如果未来加了新 kind（比如 scene_change 进 entries），narrativeToMemoryEntry 会
默认返回 null（TS 的 switch case 穷尽检查会提醒）。

### R5: 并发 generate（理论不存在但防御性）

narrative_entries 有 unique(playthroughId, orderIdx)，并发写会被 DB 拒绝。
memory adapter 的 reader.readRecent 可能看到"尚未写完"的中间状态。
在实际运行里 coreLoop 单线程 + WS 独占 playthrough，不会有并发 generate。

---

## 验收标准

- 前端 tsc clean
- 前端测试 111+ pass（新增 mapping / legacy-memory 测试）
- 后端测试 114 pass（不变）
- `grep -n "state.entries" src/core/memory/` 在 legacy / llm-summarizer 里 = 0
- legacy v1 snapshot 能正确 restore（pinned 保留、summaries 保留）
- 手动 smoke：启动 server，legacy playthrough 重连后 retrieve 返回的 summary 非空（如果之前有内容）
- `game-session.ts` 里双写 narrative 的长注释可以删除（留给下一次 commit）
