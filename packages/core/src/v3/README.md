# v3 — Generic Agent Kernel

Clean room agent loop。Stateless reducer kernel + thin driver + caller-injected
context assembly。设计支撑三种 IO 模式：

- **CLI REPL** — `packages/core/scripts/v3/repl.mts`（含 IO，scripts tsconfig）
- **Eval batch** — `packages/core/scripts/v3/eval.mts`（含 IO + Bun.write）
- **VN Orchestrator** — 取代当前 `GameSession`，按 turn 调内核

**核心库（`src/v3/`）保持 IO-pure**：不读 `process.env` / `Bun.env`，不调
node:fs / node:readline。所有 IO-heavy runner 形态在 `scripts/v3/` 下。
跟现有 `evaluation/` (lib) + `scripts/evals/` (runner) 模式一致。

## 设计约束

- **Stateless kernel**：`run(input)` 是纯函数，输入 (model, **system: string**, messages, tools) → AsyncIterable<KernelEvent>
- **零 IVN 概念**：内核不知道 scene / sprite / parser-v2 / narrative 协议
- **Section / Budget 不在 kernel**：`packSections` 是 caller-side helper，把 sections + budget 拼成 `system: string` 喂 kernel。Kernel 只接拼好的 system。换句话说，"context 拼装方案"是 caller 的实验空间，kernel 不知此概念
- **零业务 followup**：每次 `run()` 只跑一次 LLM 调用周期。多次 invoke（length 续写 / empty / signal nudge）由 caller 决定
- **AsyncIterable 接口**：`for await` 消费 + `try/catch` 错误
- **Plain TS first**：Effect-TS 迁移延后。破口集中地见
  [`docs/refactor/v3-effect-migration-plan.md`](../../../../docs/refactor/v3-effect-migration-plan.md)

## 公共 API

```ts
import {
  run,
  packSections,
  estimateTokens,
  consumeKernel,
  withRetry,
  type Section,
  type Tool,
  type RunInput,
  type KernelEvent,
} from '#internal/v3';
```

## 三 Caller 模板

### 1. CLI REPL（`scripts/v3/repl.mts`）

User 自写 entry .mts 放 `packages/core/scripts/v3/exp/`：

```ts
import { startRepl } from '../repl.mts';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

await startRepl({
  model: openai('gpt-4o'),
  tools: {
    now: {
      description: '当前时间',
      inputSchema: z.object({}),
      execute: async () => new Date().toISOString(),
    },
  },
  buildSections: ({ messages }) => ({
    systemSections: [
      { id: 'role', content: 'You are a helpful assistant', priority: 1 },
    ],
    contextSections: [],
    budgetTokens: 4000,
  }),
});
```

启动：`bun packages/core/scripts/v3/exp/my-experiment.mts`。

写死行为：

- `> ` 提示符，单行 readline，回车提交
- text-delta → stdout / reasoning-delta → stderr (dim)
- tool call/result/error → stdout 一行简显（args 截 100 字符）
- 每 turn 末展示 finishReason + outputTokens
- Ctrl+C 退（不区分 abort vs exit）
- in-memory `ModelMessage[]` history，重启清空

### 2. Eval Batch（`scripts/v3/eval.mts`，含长 turn 模拟）

```ts
import { runEvalBatch, type Scenario } from '../eval.mts';
import { openai } from '@ai-sdk/openai';

const scriptedScenario: Scenario = {
  id: 'happy-path-script',
  initialMessages: [{ role: 'system', content: 'You are...' }],
  nextUserInput: async (ctx) => {
    const inputs = ['hi', 'what time is it', 'thanks'];
    return inputs[ctx.turn] ?? null;
  },
  // maxTurns 不写 → 必须 MAX_TURNS env
};

// 长 turn 模拟玩家：复用现 evaluation/player-simulator.mts
// const sim = createLLMPlayerSimulator(persona);
// const simulatedScenario: Scenario = {
//   id: 'long-conversation',
//   nextUserInput: async (ctx) => sim.next(ctx.lastAssistant ?? ''),
//   maxTurns: 50,  // 显式覆盖 env
// };

await runEvalBatch({
  model: openai('gpt-4o'),
  tools: { /* ... */ },
  buildSections: ({ messages }) => ({ /* ... */ }),
  scenarios: [scriptedScenario],
  reps: 3,
  outputJsonl: '/tmp/exp-v1.jsonl',
});
```

启动：`MAX_TURNS=20 bun packages/core/scripts/v3/exp/my-eval.mts`。

写死行为：

- 每 scenario × rep 一行 jsonl（含全部 turn 的 events 数组）
- reps 默认 1，maxTurns 必须 scenario.maxTurns 或 `MAX_TURNS` env 至少一个
- 输出格式 jsonl 一种，默认路径 `/tmp/v3-eval.jsonl`
- 无 expected 断言 / 无多 variant 内置（caller 多次调实现 A/B）
- 单 turn run 失败 → events 注入合成 `final{finishReason:'error'}`，不中断 scenario

### 3. VN Orchestrator

```ts
import { consumeKernel } from '#internal/v3';

await consumeKernel(
  run({
    model,
    assemble: buildVNSections(...),
    messages: projectFromCoreEvents(...),
    tools,
  }),
  {
    'text-delta': (ev, s) => {
      parser.feed(ev.text);
      publishBatch(...);
      return s;
    },
    'tool-call': (ev, s) => {
      traceHandle.startToolCall(ev.name, ev.args);
      return s;
    },
    final: (ev, s) => {
      memory.appendTurn(...);
      persist(...);
      return s;
    },
  },
  initialState,
);
```

## 文件地图

**Kernel**（`src/v3/kernel/`，pure，无 IO，仅认 `system: string` + messages + tools）：

| 文件 | 职责 |
|---|---|
| `kernel/types.mts` | Tool / RunInput / KernelEvent / SourceEvent / Decision / FinishReason / TokenUsage / ToolCallRecord 等 |
| `kernel/state.mts` | 内部 `KernelStateInternal` + `initialState` 工厂 |
| `kernel/step.mts` | 纯 reducer `(state, src) → {state, decisions}` |
| `kernel/driver.mts` | `async function* run(input)` — 调 AI SDK `streamText`，派发 decisions |
| `kernel/errors.mts` | Tagged error classes（Effect 迁移锚点） |
| `kernel/__tests__/step.test.mts` | step reducer 单测 |

**Caller-side helpers**（`src/v3/`，pure 但不属于 kernel；caller 选用）：

| 文件 | 职责 |
|---|---|
| `assemble.mts` | `packSections` + `Section` / `AssembleInput` / `AssembledPrompt` / `DroppedSection` 类型 — 拼 `system: string`。Kernel 不知此概念 |
| `tokens.mts` | `estimateTokens` — char/4 + CJK 启发式（被 assemble 用） |
| `consume.mts` | `consumeKernel` / `collectAllEvents` helpers — 迁移锚点 |
| `retry.mts` | `withRetry(fn, opts)` helper — 迁移锚点 |
| `__tests__/assemble.test.mts` | packSections 单测 |

**Scripts**（`packages/core/scripts/v3/`，bun 类型 + IO）：

| 文件 | 职责 |
|---|---|
| `repl.mts` | `startRepl(config)` — CLI REPL（单行 readline / Ctrl+C 直退） |
| `eval.mts` | `runEvalBatch(config)` — 批量 scenario × turn 模拟，Bun.write jsonl |
| `_model.mts` | `buildModelFromEnv()` — 共用 LanguageModel 工厂（读 LLM_* env） |
| `exp/*.mts` | **User 实验专用目录**。每个 `.mts` 是一份独立实验（自定 buildSections / scenario / model 配置）。`smoke-eval.mts` / `smoke-repl.mts` 是模板示例。新实验 `cp smoke-eval.mts exp-v1.mts` 改即可 |
| `index.mts` | 顶层 re-export |

## 项目 idiom

- Imports 用 `#internal/v3/...` alias（无 `.mts` 后缀）
- 类型默认 `readonly`
- 错误带 `_tag: 'Foo' as const` —  未来 `Data.TaggedError` 迁移锚点
- Caller 端 helpers (`consume.mts` / `retry.mts`) 是迁移破口集中地
- AGENTS.md "pure core, imperative shell"：step.mts 纯 / driver.mts 薄壳
