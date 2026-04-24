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
import { randomUUID } from 'node:crypto';
import type {
  ScriptManifest,
  PromptSegment,
  CharacterAsset,
  BackgroundAsset,
  SpriteAsset,
} from '@ivn/core/types';
import { rehashSegment } from '@ivn/core/architect/prompt-splitter';
import { estimateTokens } from '@ivn/core/tokens';
import { scriptService } from '../services/script-service';
import { scriptVersionService } from '../services/script-version-service';
import { assetService, type AssetKind } from '../services/asset-service';
import { getAssetStorage } from '../services/asset-storage';
import { requireAdmin, isResponse, type Identity } from '../auth-identity';

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
// 资产上传辅助：共享给 upload / add_background / add_character_sprite
// ============================================================================

/** 推扩展名（和 routes/assets.ts 里保持一致，不依赖它只是为了避免循环依赖） */
function extFromMime(mime: string | undefined): string {
  if (!mime) return '';
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'image/avif': '.avif',
  };
  return map[mime.toLowerCase()] ?? '';
}

/**
 * 从 data URL / 裸 base64 串里取出真实 base64 payload。
 * Claude Desktop / 各种 MCP client 传图片时格式不统一：
 *   - 裸 base64（纯 A-Z a-z 0-9 +/= 序列）
 *   - `data:image/png;base64,iVBOR...`
 * 这里统一剥成裸 payload。
 */
function stripBase64Prefix(raw: string): string {
  const trimmed = raw.trim();
  const m = trimmed.match(/^data:[^;]+;base64,(.+)$/i);
  return m ? m[1]! : trimmed;
}

/** base64 → Buffer，失败抛友好错误 */
function decodeBase64Image(raw: string): Uint8Array {
  const payload = stripBase64Prefix(raw);
  // Node / Bun 的 Buffer.from 对非法 base64 不抛错、会悄悄丢字符，所以自检一下
  if (!/^[A-Za-z0-9+/=\s]+$/.test(payload)) {
    throw new Error('imageBase64 contains non-base64 characters');
  }
  const buf = Buffer.from(payload, 'base64');
  if (buf.length === 0) {
    throw new Error('imageBase64 decoded to empty bytes');
  }
  return new Uint8Array(buf);
}

// 10 MB 上限（解码后的原始字节，不是 base64 字符串长度）
const MAX_ASSET_BYTES = 10 * 1024 * 1024;

/** 允许的图片 MIME 白名单 */
const ALLOWED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'image/avif',
]);

interface UploadedAsset {
  assetId: string;
  storageKey: string;
  assetUrl: string;
  sizeBytes: number;
  contentType: string;
  kind: AssetKind;
}

/**
 * 把 base64 解码后的图片流式上传到 S3 并记录到 script_assets 表。
 * MCP 的 upload_script_asset / add_background / add_character_sprite 三个 tool 共享此函数。
 *
 * **不做 manifest 更新**，那是 caller 的事。
 */
async function uploadImageBytes(params: {
  scriptId: string;
  kind: AssetKind;
  contentType: string;
  imageBase64: string;
  originalName?: string;
  uploadedByUserId: string;
}): Promise<UploadedAsset> {
  const contentType = params.contentType.toLowerCase();
  if (!ALLOWED_IMAGE_MIMES.has(contentType)) {
    throw new Error(
      `Unsupported contentType: ${params.contentType}. Allowed: ${Array.from(ALLOWED_IMAGE_MIMES).join(', ')}`,
    );
  }

  const bytes = decodeBase64Image(params.imageBase64);
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    throw new Error(
      `Image too large: ${bytes.byteLength} bytes (max ${MAX_ASSET_BYTES}). ` +
        `Either compress the image or split it.`,
    );
  }

  // 确保 script 存在（否则 FK constraint 会在 DB 层挂，报错不友好）
  const ownerId = await scriptService.getOwnerId(params.scriptId);
  if (!ownerId) throw new Error(`Script not found: ${params.scriptId}`);

  const assetId = randomUUID();
  const ext = extFromMime(contentType);
  const storageKey = `scripts/${params.scriptId}/${assetId}${ext}`;

  const storage = getAssetStorage();
  // Bun 的 Blob.stream() 返回 Web ReadableStream，S3AssetStorage.put 接受它
  const stream = new Blob([bytes as unknown as BlobPart], { type: contentType }).stream();

  await storage.put(storageKey, stream, contentType, {
    app: 'ivn-engine',
    'script-id': params.scriptId,
    'asset-kind': params.kind,
    'uploaded-by': params.uploadedByUserId,
    source: 'mcp',
  });

  const row = await assetService.create({
    id: assetId,
    scriptId: params.scriptId,
    kind: params.kind,
    storageKey,
    originalName: params.originalName ?? null,
    contentType,
    sizeBytes: bytes.byteLength,
  });

  return {
    assetId: row.id,
    storageKey: row.storageKey,
    assetUrl: `/api/assets/${row.storageKey}`,
    sizeBytes: row.sizeBytes ?? bytes.byteLength,
    contentType: row.contentType ?? contentType,
    kind: row.kind,
  };
}

/**
 * 拿到"最新版本"（published 优先，否则最新一条）的完整 manifest + 版本信息。
 * 给 manifest mutation tool 做基线用。
 */
async function getBaselineVersion(scriptId: string) {
  const allVersions = await scriptVersionService.listByScript(scriptId);
  if (allVersions.length === 0) throw new Error(`Script ${scriptId} has no versions to edit`);
  const base = await scriptVersionService.getById(allVersions[0]!.id);
  if (!base) throw new Error('Base version missing');
  return base;
}

/** 从 manifest 中定位一个 segment（按 chapterId + segmentId），返回引用位置（便于 mutate） */
function findSegment(
  manifest: ScriptManifest,
  chapterId: string,
  segmentId: string,
): { chapterIdx: number; segmentIdx: number; segment: PromptSegment } | null {
  const chapterIdx = manifest.chapters.findIndex((c) => c.id === chapterId);
  if (chapterIdx < 0) return null;
  const chapter = manifest.chapters[chapterIdx]!;
  const segmentIdx = chapter.segments.findIndex((s) => s.id === segmentId);
  if (segmentIdx < 0) return null;
  return { chapterIdx, segmentIdx, segment: chapter.segments[segmentIdx]! };
}

const tools: ToolDef[] = [
  // ------------------------------------------------------------------------
  // 只读 tools
  // ------------------------------------------------------------------------
  {
    name: 'list_scripts',
    description:
      '列出所有剧本（含 label / description / 最新版本信息）。Admin 能看所有编剧的剧本。' +
      '返回的每条 item 里 scriptId 可以传给其他 tool 定位剧本。',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async handler() {
      const scripts = await scriptService.listAll();
      const enriched = await Promise.all(
        scripts.map(async (s) => {
          const versions = await scriptVersionService.listByScript(s.id);
          const published = versions.find((v) => v.status === 'published');
          const latest = versions[0] ?? null; // 按 versionNumber desc
          return {
            scriptId: s.id,
            label: s.label,
            description: s.description,
            authorUserId: s.authorUserId,
            updatedAt: s.updatedAt.toISOString(),
            versionCount: versions.length,
            publishedVersionId: published?.id ?? null,
            publishedVersionNumber: published?.versionNumber ?? null,
            latestVersionId: latest?.id ?? null,
            latestVersionNumber: latest?.versionNumber ?? null,
            latestVersionStatus: latest?.status ?? null,
          };
        }),
      );
      return textResult({ scripts: enriched });
    },
  },

  {
    name: 'list_script_versions',
    description: '列出某剧本的所有版本（draft / published / archived）。不含 manifest 大字段。',
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'string', description: '剧本 id（见 list_scripts）' },
      },
      required: ['scriptId'],
      additionalProperties: false,
    },
    async handler(args) {
      const scriptId = String(args.scriptId);
      const owner = await scriptService.getOwnerId(scriptId);
      if (!owner) throw new Error(`Script not found: ${scriptId}`);
      const versions = await scriptVersionService.listByScript(scriptId);
      return textResult({
        scriptId,
        versions: versions.map((v) => ({
          versionId: v.id,
          versionNumber: v.versionNumber,
          status: v.status,
          label: v.label,
          note: v.note,
          createdAt: v.createdAt.toISOString(),
          publishedAt: v.publishedAt?.toISOString() ?? null,
        })),
      });
    },
  },

  {
    name: 'get_script_overview',
    description:
      '取剧本的"结构大纲"：label / description / chapters 列表 + 每章 segments 的 id/label/type/role/' +
      'priority/前 120 字预览。目的是让 AI 能在不拉完整 manifest 的前提下决定要改哪个 segment。' +
      '默认取剧本当前最新的版本（published 优先，fallback 到最新 draft）。',
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'string', description: '剧本 id' },
        versionId: {
          type: 'string',
          description: '可选：指定版本 id；不传则取 published，无 published 则取最新 draft',
        },
      },
      required: ['scriptId'],
      additionalProperties: false,
    },
    async handler(args) {
      const scriptId = String(args.scriptId);
      const versionId = args.versionId ? String(args.versionId) : undefined;
      const script = await scriptService.getById(scriptId);
      if (!script) throw new Error(`Script not found: ${scriptId}`);

      const version = versionId
        ? await scriptVersionService.getById(versionId)
        : (await scriptVersionService.getCurrentPublished(scriptId))
          ?? (await (async () => {
            const all = await scriptVersionService.listByScript(scriptId);
            return all.length > 0 ? scriptVersionService.getById(all[0]!.id) : null;
          })());
      if (!version) throw new Error(`No version found for script ${scriptId}`);
      if (version.scriptId !== scriptId) throw new Error(`Version ${version.id} does not belong to script ${scriptId}`);

      const m = version.manifest;
      return textResult({
        scriptId,
        scriptLabel: script.label,
        scriptDescription: script.description,
        versionId: version.id,
        versionNumber: version.versionNumber,
        versionStatus: version.status,
        manifestLabel: m.label,
        manifestDescription: m.description,
        tags: m.tags ?? [],
        author: m.author,
        stateVariables: m.stateSchema.variables.map((v) => ({
          name: v.name,
          type: v.type,
          initial: v.initial,
          description: v.description,
        })),
        chapters: m.chapters.map((c) => ({
          chapterId: c.id,
          chapterLabel: c.label,
          segmentCount: c.segments.length,
          segments: c.segments.map((s) => ({
            segmentId: s.id,
            label: s.label,
            type: s.type,
            role: s.role,
            priority: s.priority,
            tokenCount: s.tokenCount,
            preview: s.content.slice(0, 120) + (s.content.length > 120 ? '…' : ''),
          })),
        })),
      });
    },
  },

  {
    name: 'get_segment',
    description: '取单个 segment 的完整内容（原文 + 可能存在的 derivedContent 改写版本）。',
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'string' },
        chapterId: { type: 'string' },
        segmentId: { type: 'string' },
        versionId: {
          type: 'string',
          description: '可选：指定版本；不传则取当前最新（published 优先）',
        },
      },
      required: ['scriptId', 'chapterId', 'segmentId'],
      additionalProperties: false,
    },
    async handler(args) {
      const scriptId = String(args.scriptId);
      const chapterId = String(args.chapterId);
      const segmentId = String(args.segmentId);
      const versionId = args.versionId ? String(args.versionId) : undefined;

      const version = versionId
        ? await scriptVersionService.getById(versionId)
        : (await scriptVersionService.getCurrentPublished(scriptId))
          ?? (await (async () => {
            const all = await scriptVersionService.listByScript(scriptId);
            return all.length > 0 ? scriptVersionService.getById(all[0]!.id) : null;
          })());
      if (!version) throw new Error(`No version found for script ${scriptId}`);

      const hit = findSegment(version.manifest, chapterId, segmentId);
      if (!hit) throw new Error(`Segment not found: ${chapterId}/${segmentId}`);
      return textResult({
        scriptId,
        versionId: version.id,
        chapterId,
        segment: hit.segment,
      });
    },
  },

  {
    name: 'get_full_manifest',
    description:
      '取剧本的完整 manifest（大 JSON）。用于需要对 manifest 做全局结构调整（加章节、改 stateSchema、' +
      '调 memoryConfig、改 promptAssemblyOrder 等）的场景。只做单 segment 内容改写的话优先用 get_segment。',
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'string' },
        versionId: { type: 'string', description: '可选' },
      },
      required: ['scriptId'],
      additionalProperties: false,
    },
    async handler(args) {
      const scriptId = String(args.scriptId);
      const versionId = args.versionId ? String(args.versionId) : undefined;

      const version = versionId
        ? await scriptVersionService.getById(versionId)
        : (await scriptVersionService.getCurrentPublished(scriptId))
          ?? (await (async () => {
            const all = await scriptVersionService.listByScript(scriptId);
            return all.length > 0 ? scriptVersionService.getById(all[0]!.id) : null;
          })());
      if (!version) throw new Error(`No version found for script ${scriptId}`);

      return textResult({
        scriptId,
        versionId: version.id,
        versionNumber: version.versionNumber,
        versionStatus: version.status,
        manifest: version.manifest,
      });
    },
  },

  // ------------------------------------------------------------------------
  // 写操作（永远创建 draft，不自动 publish —— 编剧审完再手动 publish）
  // ------------------------------------------------------------------------
  {
    name: 'update_segment_content',
    description:
      '修改单个 segment 的正文。会以"最新版本"（published 优先，否则最新 draft）为基线，' +
      '把改动打包成一个**新的 draft 版本**（不自动发布）。返回新建的 versionId。' +
      '如果要让玩家看到，编剧或 AI 需要再调 publish_script_version。',
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'string' },
        chapterId: { type: 'string' },
        segmentId: { type: 'string' },
        newContent: { type: 'string', description: '替换后的 segment.content 完整原文' },
        versionLabel: {
          type: 'string',
          description: '可选：给新 draft 版本起个名字，方便在版本列表里辨认',
        },
        versionNote: {
          type: 'string',
          description: '可选：改动说明（提交信息），会存在 script_versions.note 里',
        },
      },
      required: ['scriptId', 'chapterId', 'segmentId', 'newContent'],
      additionalProperties: false,
    },
    async handler(args) {
      const scriptId = String(args.scriptId);
      const chapterId = String(args.chapterId);
      const segmentId = String(args.segmentId);
      const newContent = String(args.newContent);
      const versionLabel = args.versionLabel ? String(args.versionLabel) : undefined;
      const versionNote = args.versionNote ? String(args.versionNote) : undefined;

      // 以最新版本作为基线
      const base = await getBaselineVersion(scriptId);

      // 深拷一份 manifest，改对应 segment
      const manifest: ScriptManifest = JSON.parse(JSON.stringify(base.manifest)) as ScriptManifest;
      const hit = findSegment(manifest, chapterId, segmentId);
      if (!hit) throw new Error(`Segment not found: ${chapterId}/${segmentId}`);

      const prev = hit.segment;
      const updated: PromptSegment = rehashSegment({
        ...prev,
        content: newContent,
        tokenCount: estimateTokens(newContent),
        // 新写入的"原文"替换了旧的 derived（保持一致性，避免后续玩家读到老的 derived）
        derivedContent: undefined,
        useDerived: false,
      });
      manifest.chapters[hit.chapterIdx]!.segments[hit.segmentIdx] = updated;

      const result = await scriptVersionService.create({
        scriptId,
        manifest,
        label: versionLabel,
        note: versionNote ?? `mcp: update segment ${chapterId}/${segmentId}`,
        status: 'draft',
      });
      return textResult({
        scriptId,
        baseVersionId: base.id,
        baseVersionNumber: base.versionNumber,
        newVersionId: result.version.id,
        newVersionNumber: result.version.versionNumber,
        created: result.created,
        segment: {
          chapterId,
          segmentId,
          oldContentLength: prev.content.length,
          newContentLength: newContent.length,
          oldTokenCount: prev.tokenCount,
          newTokenCount: updated.tokenCount,
        },
        note: result.created
          ? '已生成新 draft 版本。预览 / 发布前请用 list_script_versions 或 get_script_overview 复核，' +
            '然后 publish_script_version 发布。'
          : '提交内容与最新版本完全一致，未新建版本（hash 去重）。',
      });
    },
  },

  {
    name: 'replace_script_manifest',
    description:
      '用完整的 manifest JSON 覆盖剧本（创建新 draft 版本）。用于结构性修改（加章节 / 改 stateSchema / ' +
      '改 memoryConfig 等）。传入的 manifest 必须是**完整的 ScriptManifest**，不是 partial patch。' +
      '强烈建议：先用 get_full_manifest 拿到基线，在基础上改动后再调这个 tool，避免误删字段。',
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'string' },
        manifest: { type: 'object', description: '完整的 ScriptManifest JSON' },
        versionLabel: { type: 'string' },
        versionNote: { type: 'string' },
      },
      required: ['scriptId', 'manifest'],
      additionalProperties: false,
    },
    async handler(args) {
      const scriptId = String(args.scriptId);
      const manifest = args.manifest as ScriptManifest;
      const versionLabel = args.versionLabel ? String(args.versionLabel) : undefined;
      const versionNote = args.versionNote ? String(args.versionNote) : undefined;

      // 最少结构校验（不做深度 zod validation —— Elysia 这层只做 shape 兜底，
      // 真正的 validation 在 GameSession 跑起来那刻才有意义）
      if (!manifest || typeof manifest !== 'object') throw new Error('manifest must be an object');
      if (!Array.isArray(manifest.chapters)) throw new Error('manifest.chapters must be an array');
      if (!manifest.stateSchema || !Array.isArray(manifest.stateSchema.variables)) {
        throw new Error('manifest.stateSchema.variables must be an array');
      }
      if (!manifest.memoryConfig || typeof manifest.memoryConfig !== 'object') {
        throw new Error('manifest.memoryConfig is required');
      }

      // 确保剧本存在
      const script = await scriptService.getById(scriptId);
      if (!script) throw new Error(`Script not found: ${scriptId}`);

      const result = await scriptVersionService.create({
        scriptId,
        manifest,
        label: versionLabel,
        note: versionNote ?? 'mcp: replace manifest',
        status: 'draft',
      });
      return textResult({
        scriptId,
        newVersionId: result.version.id,
        newVersionNumber: result.version.versionNumber,
        created: result.created,
        note: result.created ? '已生成新 draft 版本。' : '与最新版本内容一致，未新建（hash 去重）。',
      });
    },
  },

  // ------------------------------------------------------------------------
  // 资产上传（图片）
  // ------------------------------------------------------------------------
  {
    name: 'list_script_assets',
    description:
      '列出某剧本已上传的所有图片资产（立绘 / 背景）。返回每条的 assetId / storageKey / assetUrl / kind。' +
      '用于：AI 上传新图前查有没有可复用的；或者编剧让 AI "列一下我已经传了哪些图"。',
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'string' },
      },
      required: ['scriptId'],
      additionalProperties: false,
    },
    async handler(args) {
      const scriptId = String(args.scriptId);
      const owner = await scriptService.getOwnerId(scriptId);
      if (!owner) throw new Error(`Script not found: ${scriptId}`);
      const assets = await assetService.listByScript(scriptId);
      return textResult({
        scriptId,
        assets: assets.map((a) => ({
          assetId: a.id,
          kind: a.kind,
          storageKey: a.storageKey,
          assetUrl: `/api/assets/${a.storageKey}`,
          originalName: a.originalName,
          contentType: a.contentType,
          sizeBytes: a.sizeBytes,
          createdAt: a.createdAt.toISOString(),
        })),
      });
    },
  },

  {
    name: 'upload_script_asset',
    description:
      '【低阶】把一张图片上传到剧本的资产库。只上传 + 记元数据，**不改 manifest**。' +
      '返回 assetUrl 可以自己后续塞进 manifest（用 replace_script_manifest）。' +
      '日常使用优先用高阶 tool add_background_to_script / add_character_sprite ——' +
      '它们会一步做完"上传 + 挂到 manifest + 建新 draft"。',
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'string' },
        kind: {
          type: 'string',
          enum: ['sprite', 'background'],
          description: '"sprite" = 角色立绘（会归档到 kind=sprite）；"background" = 场景背景',
        },
        contentType: {
          type: 'string',
          description: 'MIME 类型，如 image/png / image/jpeg / image/webp',
        },
        imageBase64: {
          type: 'string',
          description:
            '图片原始字节的 base64 编码。支持 "data:image/png;base64,..." 前缀，也支持裸 base64。' +
            '解码后最大 10 MB。',
        },
        originalName: {
          type: 'string',
          description: '可选：原始文件名（仅用于 DB 记录 / 诊断，不影响 URL）',
        },
      },
      required: ['scriptId', 'kind', 'contentType', 'imageBase64'],
      additionalProperties: false,
    },
    async handler(args, identity) {
      const scriptId = String(args.scriptId);
      const kind = String(args.kind) as AssetKind;
      if (kind !== 'sprite' && kind !== 'background') throw new Error(`Invalid kind: ${kind}`);
      const contentType = String(args.contentType);
      const imageBase64 = String(args.imageBase64);
      const originalName = args.originalName ? String(args.originalName) : undefined;

      const asset = await uploadImageBytes({
        scriptId,
        kind,
        contentType,
        imageBase64,
        originalName,
        uploadedByUserId: identity.userId,
      });
      return textResult({
        ...asset,
        note: '已上传。要让它在剧本里生效，还需要把 assetUrl 挂进 manifest（' +
          '背景 → manifest.backgrounds[]，立绘 → manifest.characters[].sprites[]）。' +
          '推荐直接用 add_background_to_script / add_character_sprite 自动完成。',
      });
    },
  },

  {
    name: 'add_background_to_script',
    description:
      '【高阶】上传一张背景图 + 把它作为 BackgroundAsset 加到 manifest.backgrounds[] + 建新 draft 版本。' +
      '如果 backgroundId 已存在，会用新图覆盖（assetUrl / label 更新）。' +
      '不自动 publish —— 需要编剧复核后再调 publish_script_version。',
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'string' },
        backgroundId: {
          type: 'string',
          description: 'snake_case 背景 id，会被 LLM 在 change_scene 工具里引用。例：classroom_evening',
        },
        label: { type: 'string', description: '可选：人读描述，如 "教室·黄昏"' },
        contentType: { type: 'string', description: 'image/png 等' },
        imageBase64: { type: 'string', description: 'base64 或 data URL' },
        versionLabel: { type: 'string' },
        versionNote: { type: 'string' },
      },
      required: ['scriptId', 'backgroundId', 'contentType', 'imageBase64'],
      additionalProperties: false,
    },
    async handler(args, identity) {
      const scriptId = String(args.scriptId);
      const backgroundId = String(args.backgroundId);
      const label = args.label ? String(args.label) : undefined;
      const contentType = String(args.contentType);
      const imageBase64 = String(args.imageBase64);
      const versionLabel = args.versionLabel ? String(args.versionLabel) : undefined;
      const versionNote = args.versionNote ? String(args.versionNote) : undefined;

      const base = await getBaselineVersion(scriptId);
      const manifest: ScriptManifest = JSON.parse(JSON.stringify(base.manifest)) as ScriptManifest;

      // 先上传，拿到 assetUrl；失败就在这里抛，没必要再动 manifest
      const asset = await uploadImageBytes({
        scriptId,
        kind: 'background',
        contentType,
        imageBase64,
        originalName: label,
        uploadedByUserId: identity.userId,
      });

      // 写入 / 更新 backgrounds[]
      const backgrounds: BackgroundAsset[] = manifest.backgrounds ?? [];
      const existingIdx = backgrounds.findIndex((b) => b.id === backgroundId);
      const newEntry: BackgroundAsset = {
        id: backgroundId,
        assetUrl: asset.assetUrl,
        ...(label !== undefined ? { label } : {}),
      };
      let replaced = false;
      if (existingIdx >= 0) {
        // 保留原 label 如果没传新的
        const old = backgrounds[existingIdx]!;
        backgrounds[existingIdx] = {
          ...old,
          assetUrl: asset.assetUrl,
          ...(label !== undefined ? { label } : {}),
        };
        replaced = true;
      } else {
        backgrounds.push(newEntry);
      }
      manifest.backgrounds = backgrounds;

      const result = await scriptVersionService.create({
        scriptId,
        manifest,
        label: versionLabel,
        note: versionNote ?? `mcp: ${replaced ? 'update' : 'add'} background ${backgroundId}`,
        status: 'draft',
      });

      return textResult({
        scriptId,
        backgroundId,
        assetUrl: asset.assetUrl,
        assetId: asset.assetId,
        sizeBytes: asset.sizeBytes,
        replaced,
        baseVersionId: base.id,
        newVersionId: result.version.id,
        newVersionNumber: result.version.versionNumber,
        note: replaced
          ? '已覆盖同名 background，并生成新 draft 版本。'
          : '已新增 background，并生成新 draft 版本。',
      });
    },
  },

  {
    name: 'add_character_sprite',
    description:
      '【高阶】上传一张角色立绘 + 把它作为 SpriteAsset 加到 manifest.characters[id=characterId].sprites[] ' +
      '+ 建新 draft 版本。如果 character 还不存在会自动创建（此时 characterDisplayName 必填）。' +
      '如果 spriteId 在该角色下已存在，会用新图覆盖。不自动 publish。',
    inputSchema: {
      type: 'object',
      properties: {
        scriptId: { type: 'string' },
        characterId: {
          type: 'string',
          description: 'snake_case 角色 id，会被 LLM 在 change_sprite 工具里引用。例：aonkei',
        },
        characterDisplayName: {
          type: 'string',
          description: '角色不存在时必填：UI 呈现名，如 "昂晴"。character 已存在时传入会更新 displayName',
        },
        spriteId: {
          type: 'string',
          description: 'snake_case 表情 / 姿态 id，例：smiling / crying / praying',
        },
        spriteLabel: { type: 'string', description: '可选：人读描述' },
        contentType: { type: 'string' },
        imageBase64: { type: 'string' },
        versionLabel: { type: 'string' },
        versionNote: { type: 'string' },
      },
      required: ['scriptId', 'characterId', 'spriteId', 'contentType', 'imageBase64'],
      additionalProperties: false,
    },
    async handler(args, identity) {
      const scriptId = String(args.scriptId);
      const characterId = String(args.characterId);
      const characterDisplayName = args.characterDisplayName
        ? String(args.characterDisplayName)
        : undefined;
      const spriteId = String(args.spriteId);
      const spriteLabel = args.spriteLabel ? String(args.spriteLabel) : undefined;
      const contentType = String(args.contentType);
      const imageBase64 = String(args.imageBase64);
      const versionLabel = args.versionLabel ? String(args.versionLabel) : undefined;
      const versionNote = args.versionNote ? String(args.versionNote) : undefined;

      const base = await getBaselineVersion(scriptId);
      const manifest: ScriptManifest = JSON.parse(JSON.stringify(base.manifest)) as ScriptManifest;
      const characters: CharacterAsset[] = manifest.characters ?? [];

      let charIdx = characters.findIndex((c) => c.id === characterId);
      let createdCharacter = false;
      if (charIdx < 0) {
        if (!characterDisplayName) {
          throw new Error(
            `Character ${characterId} does not exist yet; please provide characterDisplayName to create it.`,
          );
        }
        characters.push({
          id: characterId,
          displayName: characterDisplayName,
          sprites: [],
        });
        charIdx = characters.length - 1;
        createdCharacter = true;
      } else if (characterDisplayName) {
        characters[charIdx] = { ...characters[charIdx]!, displayName: characterDisplayName };
      }

      // 上传图片
      const asset = await uploadImageBytes({
        scriptId,
        kind: 'sprite',
        contentType,
        imageBase64,
        originalName: `${characterId}-${spriteId}`,
        uploadedByUserId: identity.userId,
      });

      const character = characters[charIdx]!;
      const sprites: SpriteAsset[] = [...character.sprites];
      const spriteIdx = sprites.findIndex((s) => s.id === spriteId);
      const newSprite: SpriteAsset = {
        id: spriteId,
        assetUrl: asset.assetUrl,
        ...(spriteLabel !== undefined ? { label: spriteLabel } : {}),
      };
      let replacedSprite = false;
      if (spriteIdx >= 0) {
        const old = sprites[spriteIdx]!;
        sprites[spriteIdx] = {
          ...old,
          assetUrl: asset.assetUrl,
          ...(spriteLabel !== undefined ? { label: spriteLabel } : {}),
        };
        replacedSprite = true;
      } else {
        sprites.push(newSprite);
      }
      characters[charIdx] = { ...character, sprites };
      manifest.characters = characters;

      const result = await scriptVersionService.create({
        scriptId,
        manifest,
        label: versionLabel,
        note:
          versionNote
          ?? `mcp: ${createdCharacter ? 'create character + ' : ''}` +
             `${replacedSprite ? 'update' : 'add'} sprite ${characterId}/${spriteId}`,
        status: 'draft',
      });

      return textResult({
        scriptId,
        characterId,
        spriteId,
        assetUrl: asset.assetUrl,
        assetId: asset.assetId,
        sizeBytes: asset.sizeBytes,
        createdCharacter,
        replacedSprite,
        baseVersionId: base.id,
        newVersionId: result.version.id,
        newVersionNumber: result.version.versionNumber,
        note: createdCharacter
          ? '已新建 character 并挂入第一张立绘，生成新 draft 版本。'
          : replacedSprite
            ? '已覆盖同名 sprite，生成新 draft 版本。'
            : '已为现有 character 新增一张 sprite，生成新 draft 版本。',
      });
    },
  },

  {
    name: 'publish_script_version',
    description:
      '把一个 draft 版本发布为 published（会把该剧本之前的 published 版本自动 archive 掉）。' +
      '**有玩家影响**：一旦 publish，该剧本所有新 playthrough 会走这个版本。',
    inputSchema: {
      type: 'object',
      properties: {
        versionId: { type: 'string', description: '要发布的 draft 版本 id（见 list_script_versions）' },
      },
      required: ['versionId'],
      additionalProperties: false,
    },
    async handler(args) {
      const versionId = String(args.versionId);
      const target = await scriptVersionService.getById(versionId);
      if (!target) throw new Error(`Version not found: ${versionId}`);
      if (target.status !== 'draft') {
        throw new Error(`Cannot publish: version is ${target.status}, only draft can be published`);
      }
      const ok = await scriptVersionService.publish(versionId);
      if (!ok) throw new Error('Publish failed');
      return textResult({
        ok: true,
        publishedVersionId: versionId,
        scriptId: target.scriptId,
        versionNumber: target.versionNumber,
      });
    },
  },

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
