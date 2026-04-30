# v3 → Effect-TS 迁移计划

## 状态

**plain TS 阶段**。Effect 迁移延后到 v3 业务接口稳定后启动（预计 v3
取代 GameSession 后 1-2 月）。

本文档**动态更新**：每次 v3 演化、新增 caller、修订形态时追加条目，并同步更新
破口段落。Plain 阶段的纪律失守也记进来 —— 迁移时清账。

---

## 设计纪律：迁前形态对齐

为降迁移破坏面，v3 plain TS 阶段坚持以下纪律。每条破口对应未来一行机械替换。

### 1. 错误：tagged class with `_tag`

- **现**：
  ```ts
  class LLMRateLimitError extends Error {
    readonly _tag = 'LLMRateLimit' as const;
    constructor(public readonly retryAfterMs: number, message?: string) { ... }
  }
  ```
- **迁后**：
  ```ts
  class LLMRateLimitError extends Data.TaggedError('LLMRateLimit')<{
    retryAfterMs: number;
  }> {}
  ```
- **破口位置**：[`packages/core/src/v3/kernel/errors.mts`](../../packages/core/src/v3/kernel/errors.mts)
- **caller 影响**：`instanceof LLMRateLimitError` 仍可，新增 `Stream.catchTag('LLMRateLimit', ...)` 路径

### 2. Stream 消费：`consumeKernel` helper

- **现**：
  ```ts
  async function consumeKernel<S>(
    stream: AsyncIterable<KernelEvent>,
    handlers,
    init,
  ): Promise<S> {
    let state = init;
    for await (const ev of stream) {
      const h = handlers[ev.type];
      if (h) state = await h(ev, state);
    }
    return state;
  }
  ```
- **迁后**：换 `Stream.runForEach` + `Effect.runPromise`
- **破口位置**：[`packages/core/src/v3/consume.mts`](../../packages/core/src/v3/consume.mts)
- **纪律**：**caller 必须用 `consumeKernel`，禁止直接 `for await` 内核 stream**。
  后者会把破坏面散到每个 caller。直接 `for await` 出现 → 立刻补成 `consumeKernel`
  调用。

### 3. Retry：`withRetry` helper

- **现**：
  ```ts
  function withRetry<T>(
    fn: () => Promise<T>,
    opts: { maxAttempts; backoffMs; shouldRetry? },
  ): Promise<T>
  ```
- **迁后**：换 `Effect.retry(fn, Schedule.exponential('100 millis'))`
- **破口位置**：[`packages/core/src/v3/retry.mts`](../../packages/core/src/v3/retry.mts)
- **纪律**：caller 想重试 → 必走 `withRetry`，禁止内联 try/catch + setTimeout

### 4. 取消：abortSignal 透传

- **现**：`run({...input, abortSignal})`，driver 内部传给 streamText + tool ctx
- **迁后**：Effect Fiber interruption 自动 propagate，abortSignal 字段可保留作 backwards-compat
- **破口位置**：[`packages/core/src/v3/kernel/driver.mts`](../../packages/core/src/v3/kernel/driver.mts) 顶部参数 + tool execute ctx

### 5. Tool execute：保 Promise 不变

- **现**：`execute: (args, ctx) => Promise<output>`
- **迁后**：driver 内部 `Effect.tryPromise(() => tool.execute(args, ctx))` wrap，
  caller 提供的 Tool 不动
- **破口位置**：[`packages/core/src/v3/kernel/driver.mts`](../../packages/core/src/v3/kernel/driver.mts) tool exec dispatch 处
- **caller 影响**：零

### 6. Tracing：caller pattern match → Effect.withSpan

- **现**：caller 在 `consumeKernel` 的 handlers 里 `case 'step-started': span.start()`
- **迁后**：driver 内部 `Effect.withSpan('kernel.step')`，caller 删手动 span 代码
- **破口位置**：driver.mts + caller-side handlers
- **唯一 caller 代码删减项**，迁后简化（其余迁移是替换，这一条是减法）

### 7. Token 估算

- **现**：[`packages/core/src/v3/kernel/tokens.mts`](../../packages/core/src/v3/kernel/tokens.mts) 启发式 char/4 + CJK 1:1
- **迁后**：可选切到 `gpt-tokenizer` 或 model-specific tokenizer
- **caller 影响**：零（仍是同名同签的 `estimateTokens`）

---

## Pending Decisions（v3 内部尚未敲定）

随 grill 推进逐条结题。

- **Q10 Step reducer 决策细节**：tool-error 后是否自动续 step / max-steps 触发动作 /
  tool-calls 阶段的 in-flight 等待逻辑
- **Q11 Section 实验机制**：buildSections 是 caller 自写还是提供 builder DSL？
  hot-swap A/B 配置形态？
- **Q12 Mock LanguageModel 测试形态**：driver 单测怎么 mock streamText？
  fixture 录回放？

## Discipline（plain 阶段必守）

为收窄迁移破坏面，下列纪律：

1. **Stream 消费一律走 helper**。Caller 端禁止直接 `for await` 内核 stream。
   - 反应式消费用 `consumeKernel(stream, handlers, init)`
   - 收尽事件用 `collectAllEvents(stream)`
   - 见 [`packages/core/src/v3/consume.mts`](../../packages/core/src/v3/consume.mts)
2. **重试一律走 `withRetry`**。禁止内联 try/catch + setTimeout。见
   [`packages/core/src/v3/retry.mts`](../../packages/core/src/v3/retry.mts)
3. **错误一律 tagged class with `_tag`**。新错误类型加到
   [`packages/core/src/v3/kernel/errors.mts`](../../packages/core/src/v3/kernel/errors.mts)，
   保留 `extends Error` 形态以便 plain 阶段 `instanceof` 区分

---

## 已变更记录

### 2026-04-30 初版定稿（grill-with-docs Q1-Q8）

- 决策：plain → Effect 路线
- 内核切分定稿：kernel/{types,state,step,driver,assemble,tokens,errors}
  + helpers (consume,retry) + repl
- KernelEvent / Section / Tool / KernelError 形态对齐 Effect 兼容（`_tag` /
  readonly / 离散 union）
- consume.mts / retry.mts / errors.mts 三个迁移破口集中地就位
- package.json 加 `#internal/v3` + `./v3` 路径

### 2026-04-30 Q9.1（Kernel 边界紧缩：Section/AssembleInput 移出 kernel）

- 用户 push back：Kernel 不该知 Section / Budget / packSections 概念。
- 修：`Section / AssembleInput / AssembledPrompt / DroppedSection / packSections`
  从 `kernel/` 移到 v3 顶层（`src/v3/assemble.mts`）。`tokens.mts` 同步移出。
- Kernel 的 `RunInput.assemble: AssembleInput` → `RunInput.system: string`。
- buildSections 概念**只在 scripts/v3/**（REPL + Eval runner），不在 kernel
  也不在 v3 lib 顶层。Caller 自决拼 `system` 字符串：可用 `packSections`
  helper / 自写模板 / 任意机制。
- 测试：assemble.test.mts 移到 `src/v3/__tests__/`。typecheck 4 package 全绿；
  v3 tests 15/15 全绿。
- 迁移影响：零（plain → Effect 迁移破口数量不变；Section 永远是 caller-side
  概念，未来 Effect 迁移时也仍是 caller-side）

### 2026-04-30 Q9（REPL + Eval 形态）

- **位置**：REPL / Eval IO-heavy，进 `packages/core/scripts/v3/`（bun tsconfig）。
  Core lib `packages/core/src/v3/` 保持 IO-pure（不读 env / 不调 node:fs）。
  跟现有 `evaluation/` (lib) + `scripts/evals/` (runner) 模式一致。
- REPL：写死单行 readline + Ctrl+C 直退 + 默认渲染（reasoning dim / tool args
  截 100 字 / final summary）。无 multi-line / 无 :commands / 无 RenderOptions
  切换 / 无双 Ctrl+C。约 50 行。
- Eval：`Scenario.nextUserInput(ctx) → string | null` driver 形态统一
  scripted + simulated。多 turn 真模拟（每 turn 一次 `run()`）。整 scenario
  打包 jsonl。`maxTurns` 由 `Bun.env.MAX_TURNS` 控制（无默认）。
- Reps / 多 variant 对比 / expected 断言 / 多输出格式都不内置 → caller 自包
- Player simulator 复用现 `evaluation/player-simulator.mts`，v3 不复制
- 加 `collectAllEvents` 到 consume.mts（eval 用，迁移破口）

### YYYY-MM-DD（后续条目示例）

- ...
