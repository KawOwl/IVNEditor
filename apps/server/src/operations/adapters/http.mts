/**
 * HTTP adapter —— 把一组 op 挂到 Elysia，统一在 `POST /api/ops/:name`。
 *
 * 选单端点是因为：
 *  - 所有 op 都是 mutation（safe op 也接受 POST，避免 GET 缓存语义跟
 *    auth 混淆）
 *  - 单端点 = 一行 mount 全部 op，加新 op 不需要改路由表
 *  - RESTful 规范化对内部 admin API 没价值，CDN 缓存也无意义
 *
 * 鉴权沿用 #internal/auth-identity 的 Identity，adapter 在调 runOp 前转
 * 成 OpContext。
 */

import { Elysia } from 'elysia';
import { randomUUID } from 'node:crypto';

import { resolveIdentity } from '#internal/auth-identity';
import type { AnyOp } from '#internal/operations/op-kit';
import { runOp } from '#internal/operations/op-kit';
import { identityToOpContext, anonymousOpContext } from '#internal/operations/context';
import { OpError, opErrorToHttpStatus } from '#internal/operations/errors';

/**
 * 把 ops 挂到 Elysia 应用上。返回一个 plugin 形态，调用方
 * `app.use(buildOpRouter(ops))`。
 *
 * 返回类型故意不写明 `: Elysia`——Elysia 的链式 builder 每加一条路由都会
 * "增厚"自己的泛型，写明的话 TS 会拒绝赋值。让 TS 推断即可，调用方拿到
 * 的也是兼容 plugin。
 */
export function buildOpRouter(ops: ReadonlyArray<AnyOp>) {
  // 用 op.name 做 path 参数。Elysia 的 path 不能含 .，但 :name 是任意字符串
  // 包含点号是 OK 的（Elysia 把 `:param` 当 catch-segment）。
  // 为了清晰还是只允许在 body 里指定 name，避免 path 转义问题：

  const opIndex = new Map<string, AnyOp>();
  for (const op of ops) {
    if (opIndex.has(op.name)) {
      throw new Error(`[op-router] Duplicate op name: ${op.name}`);
    }
    opIndex.set(op.name, op);
  }

  return new Elysia({ name: 'op-router' })
    // 列出所有 op（开发期工具 / agent 用来发现可用 op）
    .get('/api/ops', () => {
      return {
        ops: Array.from(opIndex.values()).map((op) => ({
          name: op.name,
          description: op.description,
          category: op.category,
          effect: op.effect,
          auth: op.auth,
          uiLabel: op.uiLabel,
        })),
      };
    })
    // 调用入口。name 走 body 而非 path，避免 `.` 转义和路由匹配歧义
    .post('/api/ops/:name', async ({ params, body, request, set }) => {
      const requestId = request.headers.get('X-Request-Id') ?? randomUUID();
      const opName = params.name;
      const op = opIndex.get(opName);
      if (!op) {
        set.status = 404;
        return {
          ok: false,
          code: 'NOT_FOUND',
          message: `Unknown op: ${opName}`,
        };
      }

      try {
        // resolve identity（除非 op 明确 auth='none'）
        let ctx;
        if (op.auth === 'none') {
          ctx = anonymousOpContext('http', requestId);
        } else {
          const identity = await resolveIdentity(request);
          if (!identity) {
            set.status = 401;
            return {
              ok: false,
              code: 'UNAUTHORIZED',
              message: 'Authorization header required',
            };
          }
          ctx = identityToOpContext(identity, 'http', requestId);
        }

        const output = await runOp(op, body, ctx);
        return { ok: true, data: output };
      } catch (err) {
        if (err instanceof OpError) {
          set.status = opErrorToHttpStatus(err);
          return {
            ok: false,
            code: err.code,
            message: err.message,
            ...(Object.keys(err.details).length > 0 ? { details: err.details } : {}),
          };
        }
        // 未预期的 raw Error —— 记日志、返回 500，不泄漏内部细节
        console.error(`[op-router] op="${opName}" requestId="${requestId}" unhandled error:`, err);
        set.status = 500;
        return {
          ok: false,
          code: 'INTERNAL',
          message: 'Internal server error',
        };
      }
    });
}
