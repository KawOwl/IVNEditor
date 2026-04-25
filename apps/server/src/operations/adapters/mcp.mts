/**
 * MCP adapter —— 把 op 转成现有 routes/mcp.mts 用的 ToolDef 形态。
 *
 * 不接管整条 MCP 路由（routes/mcp.mts 还在），只是把"基于 op 的新 tools"
 * 推到那边的 tools 数组里。后续旧 tool 一个个迁过来时，只是把
 * routes/mcp.mts 里的 ToolDef 删掉、写一个对应的 op 即可——MCP 客户端
 * 看到的接口形状不会变。
 *
 * MCP 的鉴权目前是 admin-only（routes/mcp.mts 的 dispatcher 入口已经
 * requireAdmin 过了），所以这层 adapter 只做 op-level 的 auth 二次保险，
 * 不重复解析 token。
 */

import { z, toJSONSchema } from 'zod/v4';

import type { Identity } from '#internal/auth-identity';
import type { Op, AnyOp } from '#internal/operations/op-kit';
import { runOp } from '#internal/operations/op-kit';
import { identityToOpContext } from '#internal/operations/context';
import { OpError } from '#internal/operations/errors';

// ============================================================================
// ToolDef shape —— 必须和 routes/mcp.mts 里那个 interface 字节级一致，
// 否则两边数组合并后类型会打架。这里 re-declare 一份是为了**不让 op-kit
// 反向依赖 routes/mcp.mts**（防腐契约 #5）。
// ============================================================================

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, identity: Identity) => Promise<unknown>;
}

interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function textResult(value: unknown, isError = false): McpToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

// ============================================================================
// 转换器
// ============================================================================

/**
 * 把 op 转成 MCP tool name。
 *
 * 优先级：
 *   1. op.mcpName 显式给（用于 backward compat 旧 MCP 客户端配置）
 *   2. 否则把 `<category>.<verb>` 的 category 前缀剥掉
 *
 * 例：
 *   { name: 'script.lint_manifest' } → 'lint_manifest'
 *   { name: 'script.list_versions', mcpName: 'list_script_versions' } → 'list_script_versions'
 */
function opNameToMcpName<I, O>(op: Op<I, O>): string {
  if (op.mcpName) return op.mcpName;
  return op.name.split('.').slice(1).join('.');
}

/**
 * 把 op 转成 MCP ToolDef。zod schema 用 zod 4 自带的 toJSONSchema 转
 * （JSON Schema draft-2020-12，MCP 规范支持任意 draft）。
 */
export function opToMcpTool<I, O>(op: Op<I, O>): McpToolDef {
  // zod 4 的 toJSONSchema 在 zod/v4 子路径。MCP client 大多认 draft-7，
  // 2020-12 形状向下兼容。
  const inputSchema = toJSONSchema(op.input as z.ZodType<unknown>, {
    target: 'draft-2020-12',
  });

  // 描述里加 effect / auth tag 让 MCP client / agent 看清楚
  const taggedDescription = buildTaggedDescription(op);

  return {
    name: opNameToMcpName(op),
    description: taggedDescription,
    inputSchema: inputSchema as Record<string, unknown>,
    async handler(args, identity) {
      const ctx = identityToOpContext(
        {
          kind: identity.kind,
          userId: identity.userId,
          username: identity.username,
          displayName: identity.displayName,
        },
        'mcp',
        // MCP 协议没有标准 request-id 透传，本地生成
        crypto.randomUUID(),
      );

      try {
        const result = await runOp(op, args, ctx);
        return textResult(result);
      } catch (err) {
        if (err instanceof OpError) {
          return textResult(
            {
              ok: false,
              code: err.code,
              message: err.message,
              ...(Object.keys(err.details).length > 0 ? { details: err.details } : {}),
            },
            true,
          );
        }
        // 未预期错误：MCP 也用 isError，但消息保守
        console.error(`[op-mcp] op="${op.name}" unhandled error:`, err);
        return textResult({ ok: false, code: 'INTERNAL', message: 'Internal server error' }, true);
      }
    },
  };
}

function buildTaggedDescription<I, O>(op: Op<I, O>): string {
  const tags: string[] = [];
  if (op.effect === 'destructive') tags.push('⚠️ destructive');
  else if (op.effect === 'mutating') tags.push('mutating');
  if (op.auth !== 'admin') tags.push(`auth:${op.auth}`);
  const tagline = tags.length > 0 ? ` [${tags.join(' · ')}]` : '';
  return `${op.description}${tagline}`;
}

/** 一次转换多个 op，给 routes/mcp.mts 的 tools 数组直接 push 用 */
export function opsToMcpTools(ops: ReadonlyArray<AnyOp>): McpToolDef[] {
  return ops.map((op) => opToMcpTool(op));
}
