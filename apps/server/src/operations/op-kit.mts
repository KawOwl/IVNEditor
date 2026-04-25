/**
 * op-kit — 单源 Operation 定义 + 防腐契约
 *
 * 一个 Op = 一项业务能力的"单一定义"。HTTP 路由 / MCP tool / 前端 typed
 * client 都从这里派生，不复制定义。
 *
 * ============================================================================
 * 防腐契约（违反任何一条都会让"将来换 RPC 框架"成本 ×3）
 * ============================================================================
 * 1. Op<I, O> 类型不依赖任何 web 框架。本文件不许 import elysia / hono /
 *    express，也不许 import #internal/auth-identity（那是 web 框架边界
 *    的东西，归 adapter 处理）。
 * 2. exec(input, ctx) 的 ctx 是 OpContext 自定义形状（不是 Elysia.Context
 *    / Identity）。adapter 负责把框架原生身份对象转成 OpContext。
 * 3. 错误用 OpError 子类抛（见 errors.mts），不要 throw new Error('...')。
 *    adapter 把 OpError 翻译成 HTTP status / MCP isError content。
 * 4. Zod schema 命名 export，不要内联到 defineOp 里。reuse 是常态。
 * 5. ops 文件夹放在 apps/server/src/operations，**不依赖** routes/。
 *    将来要拆 packages/operations 子包，只要 services/ 也跟着搬即可。
 * 6. exec 不返回 Response / Headers / Set-Cookie，只返回纯数据
 *    （outputSchema parse 通过的 plain JSON）。
 * 7. 不在 exec 内做 cookie / session / 跨 origin 的处理。这些是 adapter
 *    职责。
 * 8. dry-run / undo / progress / rate-limit 这类元能力，做成 op
 *    middleware（见下文 OpMiddleware），不要 case-by-case 在每个 op 里
 *    手写。
 *
 * 上面 8 条贴在每个新 op PR 的 review 检查表里。CI lint 在
 * `__tests__/op-kit.test.mts` 里有形状检查兜底。
 */

import type { z } from 'zod/v4';
import type { OpContext } from '#internal/operations/context';
import { OpError } from '#internal/operations/errors';

// ============================================================================
// Types
// ============================================================================

/**
 * Op 的"副作用等级"，决定 adapter / agent 该怎么对待它：
 *  - 'safe'        — 只读，幂等，零副作用。可以无脑重试 / 缓存
 *  - 'mutating'    — 写库 / 写文件 / 改状态。重试要谨慎
 *  - 'destructive' — 删除 / 不可逆。adapter 应当强制走 dry-run + 二阶段
 *                    confirm（见 withConfirm middleware）
 */
export type OpEffect = 'safe' | 'mutating' | 'destructive';

/**
 * 鉴权要求。adapter 在调 exec 前做检查。
 *  - 'admin'     — 必须是 admin（roleId === 'admin'）
 *  - 'registered'— admin 或 registered（非 anonymous）
 *  - 'any'       — 任何已认证身份（含 anonymous）
 *  - 'none'      — 不需要鉴权（极少使用，例：health check 类）
 */
export type OpAuth = 'admin' | 'registered' | 'any' | 'none';

/** Op 元数据，adapter 和文档生成器都会读 */
export interface OpMeta {
  /** 全局唯一 op 名，约定 `<category>.<verb_object>`，例：'script.lint_manifest' */
  readonly name: string;
  readonly description: string;
  /** 用于分组（HTTP 文档分页、MCP tool 列表分类、agent 上下文裁剪等） */
  readonly category: string;
  readonly effect: OpEffect;
  readonly auth: OpAuth;
  /** UI / Agent 友好的简短标签（缺省用 description 的第一句） */
  readonly uiLabel?: string;
}

/** Op 主体定义。Input/Output 的运行时校验来自 Zod，类型从 z.infer 推。*/
export interface Op<I, O> extends OpMeta {
  readonly input: z.ZodType<I>;
  readonly output: z.ZodType<O>;
  /** 业务执行函数。**不许**碰 framework 类型，只用 OpContext。*/
  readonly exec: (input: I, ctx: OpContext) => Promise<O>;
}

/** defineOp 的入参（除 input/output 外，其余都是普通字段） */
export interface DefineOpInput<I, O> {
  name: string;
  description: string;
  category: string;
  effect: OpEffect;
  auth: OpAuth;
  uiLabel?: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  exec: (input: I, ctx: OpContext) => Promise<O>;
}

/**
 * Op middleware：包装一个 op，返回新 op。可以堆叠（Op → withLogging → withConfirm）。
 * adapter 不感知 middleware，只看到最终的 op。
 *
 * 用法：
 *   defineOp({ ... }) → withConfirm({ confirmField: 'confirm' }) → 落到 registry
 *
 * 不在 v0.1 实现，只占位——为防腐契约 #8 留口子。
 */
export type OpMiddleware = <I, O>(op: Op<I, O>) => Op<I, O>;

/**
 * 类型擦除版本。registry / adapter 操作"任意 op 数组"时用 AnyOp，避免
 * 函数参数 contravariance 导致的 `Op<unknown, unknown>` 不可赋值问题。
 *
 * 单个 op 定义本身保持精确类型（exec 内 input 完全类型化），只在
 * "把多个 op 装到同一个数组" 时擦除。tRPC 的 AnyProcedure 同样套路。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyOp = Op<any, any>;

// ============================================================================
// Factory
// ============================================================================

/**
 * 创建一个 op。仅做编译期类型推断辅助，零运行时开销。
 *
 * 形状刻意贴近 tRPC procedure / Hono RPC，便于将来迁移：
 * ```ts
 * // 现在：
 * defineOp({ name, input, output, effect, auth, exec });
 * // 切到 tRPC 时：
 * t.procedure.input(input).output(output).mutation(({ input, ctx }) => exec(input, ctx));
 * ```
 */
export function defineOp<I, O>(spec: DefineOpInput<I, O>): Op<I, O> {
  // 名字格式硬约束：`<category>.<verb_object>` 否则 MCP / agent 看不出归属
  if (!/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/.test(spec.name)) {
    throw new Error(
      `[op-kit] Invalid op name "${spec.name}". Required: "<category>.<snake_case_verb>" (e.g. "script.lint_manifest").`,
    );
  }
  // category 必须等于 name 的第一段
  const expectedCategory = spec.name.split('.')[0]!;
  if (spec.category !== expectedCategory) {
    throw new Error(
      `[op-kit] Op "${spec.name}" category="${spec.category}" mismatch. Expected category="${expectedCategory}".`,
    );
  }
  return {
    name: spec.name,
    description: spec.description,
    category: spec.category,
    effect: spec.effect,
    auth: spec.auth,
    uiLabel: spec.uiLabel,
    input: spec.input,
    output: spec.output,
    exec: spec.exec,
  };
}

// ============================================================================
// Runner —— adapter 共用的核心调用逻辑
// ============================================================================

/**
 * 鉴权辅助。adapter 在调 runOp 前应当先 resolve 出 OpContext，
 * 再让 runOp 做 auth 强度判定。这样 auth 错误的形状统一。
 */
export function checkAuth(op: OpMeta, ctx: OpContext): void {
  switch (op.auth) {
    case 'none':
      return;
    case 'any':
      if (!ctx.userId) throwAuth(op, 'authentication required');
      return;
    case 'registered':
      if (!ctx.userId) throwAuth(op, 'authentication required');
      if (ctx.kind === 'anonymous') throwAuth(op, 'registered identity required');
      return;
    case 'admin':
      if (!ctx.userId) throwAuth(op, 'authentication required');
      if (ctx.kind !== 'admin') throwAuth(op, 'admin role required');
      return;
  }
}

function throwAuth(op: OpMeta, msg: string): never {
  throw new OpError('UNAUTHORIZED', `${op.name}: ${msg}`);
}

/**
 * adapter 调用入口：完整跑一遍 input parse → auth → exec → output parse。
 * 任何阶段出错都抛 OpError（adapter 统一处理）。
 */
export async function runOp<I, O>(
  op: Op<I, O>,
  rawInput: unknown,
  ctx: OpContext,
): Promise<O> {
  checkAuth(op, ctx);

  const parsed = op.input.safeParse(rawInput);
  if (!parsed.success) {
    throw new OpError('INVALID_INPUT', `${op.name}: input validation failed`, {
      cause: parsed.error,
      details: { issues: parsed.error.issues },
    });
  }

  const result = await op.exec(parsed.data, ctx);

  // output 校验默认开启（开发期发现签名漂移），prod 想关可加 env flag
  const outParsed = op.output.safeParse(result);
  if (!outParsed.success) {
    throw new OpError('INTERNAL', `${op.name}: output schema mismatch (op bug)`, {
      cause: outParsed.error,
      details: { issues: outParsed.error.issues },
    });
  }
  return outParsed.data;
}

/**
 * 把一组 op 转成 name → op 的 Map，用于 adapter 路由分发。
 * 顺便验重——重名直接抛错，避免上线后才发现某个 op 被覆盖了。
 */
export function indexOps(ops: ReadonlyArray<AnyOp>): Map<string, AnyOp> {
  const m = new Map<string, AnyOp>();
  for (const op of ops) {
    if (m.has(op.name)) {
      throw new Error(`[op-kit] Duplicate op name "${op.name}"`);
    }
    m.set(op.name, op);
  }
  return m;
}
