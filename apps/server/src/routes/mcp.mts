/**
 * MCP Server Route — Model Context Protocol 服务端（Streamable HTTP transport）
 *
 * 挂在现有 Elysia 后端上，给编剧的 Claude Desktop（MCP client）做远程
 * 连接目标。编剧可以在 Claude Desktop 里直接让 AI 调用这里暴露的 tools
 * 去增删改查 scripts / script_versions，而不用手动去编辑器里点。
 *
 * 传输层（Streamable HTTP, 协议版本 2025-06-18）：
 *   - 单一 endpoint POST /api/mcp 接 JSON-RPC 2.0 请求
 *   - 单条请求 → 单条 JSON 响应（Content-Type: application/json）
 *   - Notifications（没 id）→ 返回 202 Accepted 空 body
 *   - 本服务端无 session state（不下发 Mcp-Session-Id），client 每次
 *     POST 都带完整 Authorization 自证身份
 *
 * 认证：
 *   Authorization: Bearer <user_sessions.id>  （admin only）
 *   沿用项目现有 requireAdmin，不引入独立的 MCP token 体系。
 *
 * 为什么不用 @modelcontextprotocol/sdk：
 *   SDK 是围绕 Node http.Server 设计的，要把它塞到 Elysia 里反而别扭，
 *   而 MCP over Streamable HTTP 本质是 JSON-RPC 2.0，方法数少（5 个左右），
 *   直接手写反而更简单、更好跟现有 auth 串起来。
 *
 * Claude Desktop 侧配置（编剧本地 claude_desktop_config.json）：
 * ```
 * {
 *   "mcpServers": {
 *     "ivn-scripts": {
 *       "command": "npx",
 *       "args": [
 *         "mcp-remote",
 *         "https://<staging-host>/api/mcp",
 *         "--header", "Authorization: Bearer <admin session token>"
 *       ]
 *     }
 *   }
 * }
 * ```
 * mcp-remote 会把这个远程 HTTP endpoint 包成 Claude Desktop 识别的 stdio
 * MCP server。
 */

import { Elysia } from 'elysia';
import { scriptService } from '#internal/services/script-service';
import { scriptVersionService } from '#internal/services/script-version-service';
import { assetService } from '#internal/services/asset-service';
import { requireAdmin, isResponse, type Identity } from '#internal/auth-identity';
import { ALL_OPS } from '#internal/operations/registry';
import { opsToMcpTools } from '#internal/operations/adapters/mcp';

// ============================================================================
// JSON-RPC 2.0 types
// ============================================================================

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: '2.0';
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// 标准 JSON-RPC error codes（见 https://www.jsonrpc.org/specification#error_object）
const ERR_PARSE = -32700;
const ERR_INVALID_REQUEST = -32600;
const ERR_METHOD_NOT_FOUND = -32601;
const ERR_INVALID_PARAMS = -32602;
const ERR_INTERNAL = -32603;

function makeError(id: JsonRpcRequest['id'], code: number, message: string, data?: unknown): JsonRpcError {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, data } };
}

function makeSuccess(id: JsonRpcRequest['id'], result: unknown): JsonRpcSuccess {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

// ============================================================================
// MCP server metadata
// ============================================================================

// 我们遵循 MCP 最新的稳定版 2025-06-18；client 若只支持老版本（比如 2025-03-26）
// 会在 initialize 里协商降级，目前这些方法名和形状在两版之间都兼容。
const MCP_PROTOCOL_VERSION = '2025-06-18';
const MCP_SERVER_INFO = {
  name: 'ivn-engine-scripts',
  version: '0.1.0',
  title: 'Interactive Visual Novel Engine — Scripts',
} as const;

// ============================================================================
// Tool catalog
// ============================================================================
//
// 所有 tool 的 name / description / inputSchema，通过 tools/list 暴露给
// client。inputSchema 用标准 JSON Schema（MCP 规范要求）。

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, identity: Identity) => Promise<unknown>;
}

/** 把任意 JS 值包成 MCP tool 的 content response */
function textResult(value: unknown, isError = false): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return {
    content: [{ type: 'text', text }],
    ...(isError ? { isError: true } : {}),
  };
}

// ============================================================================
// 资产上传辅助函数 → 已迁移到 operations/script/_asset-helpers.mts
// segment / version helpers → 已迁移到 operations/script/_shared.mts
// ============================================================================


const tools: ToolDef[] = [
  // ------------------------------------------------------------------------
  // 只读 tools —— 已迁移到 op-kit（apps/server/src/operations/script/）
  // 通过 tools.push(...opsToMcpTools(ALL_OPS)) 在尾部追加，保持 MCP 接口
  // 不变：list_scripts / list_script_versions / get_script_overview /
  // get_segment / get_full_manifest / list_script_assets。
  // 写 tools 还没迁，仍然走下面的本地 ToolDef。
  // ------------------------------------------------------------------------

  // ------------------------------------------------------------------------
  // 写操作（永远创建 draft，不自动 publish —— 编剧审完再手动 publish）
  // update_segment_content / replace_script_manifest 已迁到 op-kit
  // ------------------------------------------------------------------------

  // ------------------------------------------------------------------------
  // 资产上传（图片）—— upload_script_asset / add_background_to_script /
  //   add_character_sprite / list_script_assets 都已迁到 op-kit
  // publish_script_version 也已迁到 op-kit
  // ------------------------------------------------------------------------

  {
    name: 'delete_script',
    description:
      '【危险 · 不可逆】彻底删除一个剧本。级联删除：该剧本的所有版本（draft / published / archived）、' +
      '所有 playthroughs（玩家和编剧试玩）、所有 script_assets 数据库记录。' +
      '**OSS / S3 上的图片对象**不会被物理删除（只是 DB 里的引用没了），如需清理要管理员手动进 OSS 控制台。\n\n' +
      '必须显式传 `confirm: true` + 同时传 `scriptIdConfirm` 与 `scriptId` 一致才真执行 —— 防止 LLM 误触。' +
      '强烈建议：调用前先用 `list_scripts` 和 `get_script_overview` 跟用户再次确认要删的是哪个剧本。',
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'string', description: '要删除的剧本 id' },
        scriptIdConfirm: {
          type: 'string',
          description: '再输一次 scriptId，必须和上面完全一致 —— 防止传错',
        },
        confirm: {
          type: 'boolean',
          description: '必须传 true 才真删除；传 false 或不传 → 返回 "dry-run" 预览（告诉你会影响多少版本 / playthrough / asset）',
        },
      },
      required: ['scriptId'],
      additionalProperties: false,
    },
    async handler(args) {
      const scriptId = String(args.scriptId);
      const scriptIdConfirm = args.scriptIdConfirm ? String(args.scriptIdConfirm) : undefined;
      const confirm = args.confirm === true;

      // 先查出会被影响的东西，既用于 dry-run 响应，也让真删除的响应里带上删了什么
      const script = await scriptService.getById(scriptId);
      if (!script) throw new Error(`Script not found: ${scriptId}`);

      const versions = await scriptVersionService.listByScript(scriptId);
      const assets = await assetService.listByScript(scriptId);
      // playthrough 数无法从 scriptService 直接查；不想为 MCP 单独开 service 方法，
      // 先报 "不精确"提示（数据库 FK CASCADE 会自动清，不影响正确性）
      const impact = {
        scriptId,
        scriptLabel: script.label,
        versionCount: versions.length,
        assetCount: assets.length,
        publishedVersionIds: versions.filter((v) => v.status === 'published').map((v) => v.id),
        note:
          '级联删除：script_versions / playthroughs / script_assets 的数据库行会被 FK CASCADE 自动清理。' +
          'OSS / S3 上的图片文件不会被物理删除。',
      };

      if (!confirm) {
        return textResult({
          dryRun: true,
          wouldDelete: impact,
          message:
            '未传 confirm=true，已返回 dry-run。真要删请再调一次并带 `confirm: true`，同时 `scriptIdConfirm` 必须等于 scriptId。',
        });
      }
      if (scriptIdConfirm !== scriptId) {
        throw new Error(
          `Safety check failed: scriptIdConfirm (${scriptIdConfirm ?? '<missing>'}) does not match scriptId (${scriptId}). ` +
            'Re-enter scriptId in the scriptIdConfirm field to confirm.',
        );
      }

      const ok = await scriptService.delete(scriptId);
      if (!ok) throw new Error(`Delete failed (script vanished mid-op?): ${scriptId}`);

      return textResult({
        ok: true,
        deleted: impact,
        warning:
          'OSS 上的 asset 文件未物理删除。如需清理，请在 OSS 控制台按 key 前缀 scripts/' + scriptId + '/ 手动删除。',
      });
    },
  },
];

// 把 op-kit 注册的 ops（v0.1：lint_manifest）派生为 MCP tool 追加到尾部。
// 旧 tool 后续会逐个迁移到 op-kit；过渡期两边并存。
tools.push(...opsToMcpTools(ALL_OPS));

const toolByName = new Map(tools.map((t) => [t.name, t]));

// ============================================================================
// JSON-RPC method dispatcher
// ============================================================================

async function handleRequest(req: JsonRpcRequest, identity: Identity): Promise<JsonRpcResponse | null> {
  // notifications — method 以 "notifications/" 开头且无 id，不回响应
  if (req.method.startsWith('notifications/')) {
    return null;
  }

  try {
    switch (req.method) {
      case 'initialize': {
        // MCP initialize：协议握手，返回 serverInfo + capabilities。
        // 我们只做 tools，不做 resources / prompts / sampling。
        const params = (req.params ?? {}) as { protocolVersion?: string; clientInfo?: unknown };
        const clientVersion = params.protocolVersion;
        return makeSuccess(req.id, {
          // 按 spec：server 应该返回自己支持的版本；如果和 client 一致就用 client 的，
          // 否则返回 server 的首选。大多数 client 会 accept 我们返回的版本。
          protocolVersion: clientVersion ?? MCP_PROTOCOL_VERSION,
          capabilities: {
            tools: {},
          },
          serverInfo: MCP_SERVER_INFO,
          instructions:
            '这是 interactive-visual-novel-engine 的 MCP server。你可以列出、读取、修改剧本，以及上传角色立绘和场景背景图。' +
            '所有写操作（包括图片上传）都创建 draft 版本，publish 需要显式调 publish_script_version。\n\n' +
            '典型流程：\n' +
            '  - 改文字：list_scripts → get_script_overview → update_segment_content → publish_script_version\n' +
            '  - 加图：add_background_to_script / add_character_sprite（一步完成上传+manifest 挂载+建 draft）\n' +
            '  - 查已传图：list_script_assets\n' +
            '  - 删剧本：delete_script（不可逆；默认 dry-run，真删要显式 confirm=true + 重输 scriptIdConfirm）\n' +
            '写完务必让用户复核过再 publish。',
        });
      }

      case 'ping':
        return makeSuccess(req.id, {});

      case 'tools/list':
        return makeSuccess(req.id, {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });

      case 'tools/call': {
        const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
        const name = params.name;
        if (!name) return makeError(req.id, ERR_INVALID_PARAMS, 'Missing tool name');
        const tool = toolByName.get(name);
        if (!tool) return makeError(req.id, ERR_METHOD_NOT_FOUND, `Unknown tool: ${name}`);

        try {
          const result = await tool.handler(params.arguments ?? {}, identity);
          return makeSuccess(req.id, result);
        } catch (err) {
          // tool 执行错误按 MCP 约定走 result.isError=true，不走 JSON-RPC error
          // （JSON-RPC error 是协议级错误，tool 业务错误属于 "call succeeded,
          // 但 tool 报错"，client 需要看 isError）
          const msg = err instanceof Error ? err.message : String(err);
          return makeSuccess(req.id, textResult(`Tool error: ${msg}`, true));
        }
      }

      default:
        return makeError(req.id, ERR_METHOD_NOT_FOUND, `Unknown method: ${req.method}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return makeError(req.id, ERR_INTERNAL, `Internal error: ${msg}`);
  }
}

// ============================================================================
// Elysia route
// ============================================================================

export const mcpRoutes = new Elysia({ prefix: '/api/mcp' })

  // GET / — 简单的可达性/身份探活，方便 curl 调试
  // （MCP spec 允许 GET 返回 405；我们这里给人肉检查加一条友好信息）
  .get('/', async ({ request }) => {
    const id = await requireAdmin(request);
    if (isResponse(id)) return id;
    return {
      ok: true,
      server: MCP_SERVER_INFO,
      protocolVersion: MCP_PROTOCOL_VERSION,
      tools: tools.map((t) => t.name),
      note: 'POST JSON-RPC 2.0 envelopes to this URL to talk MCP.',
    };
  })

  // POST / — 核心 JSON-RPC 入口
  .post('/', async ({ body, request }) => {
    const id = await requireAdmin(request);
    if (isResponse(id)) return id;
    const identity = id;

    // MCP Streamable HTTP 允许 batch（数组）。我们都支持。
    if (Array.isArray(body)) {
      const responses: JsonRpcResponse[] = [];
      for (const item of body) {
        const req = item as JsonRpcRequest;
        if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
          responses.push(makeError(null, ERR_INVALID_REQUEST, 'Invalid JSON-RPC request'));
          continue;
        }
        const res = await handleRequest(req, identity);
        if (res) responses.push(res);
      }
      // batch 全是 notification → 返回 202 空 body
      if (responses.length === 0) {
        return new Response(null, { status: 202 });
      }
      return new Response(JSON.stringify(responses), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const req = body as JsonRpcRequest;
    if (!req || req.jsonrpc !== '2.0' || typeof req.method !== 'string') {
      return new Response(JSON.stringify(makeError(null, ERR_INVALID_REQUEST, 'Invalid JSON-RPC request')), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const res = await handleRequest(req, identity);
    if (!res) {
      // notification，不回 body
      return new Response(null, { status: 202 });
    }
    return new Response(JSON.stringify(res), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
