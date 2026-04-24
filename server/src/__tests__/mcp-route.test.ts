/**
 * MCP route 冒烟测试
 *
 * 覆盖：
 *   - 401/403：无 Authorization 或非 admin → 403
 *   - initialize：返回 protocolVersion + serverInfo + tools capability
 *   - tools/list：返回预期的 tool 名
 *   - tools/call list_scripts：空库返回空数组
 *   - tools/call update_segment_content：能写出新 draft
 *   - notifications/initialized：204/202 空 body
 *   - 非法 jsonrpc：400
 *
 * 目的是 catch "JSON-RPC 解析错 / 方法名错 / 返回形状错 / auth 绕过" 这类
 * 线上跑起来才会暴露的协议级 bug。业务逻辑（scriptService 深坑）由各
 * service 单测兜底，这里不重复。
 */

import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { buildApp } from '../app';
import { db, schema } from '../db';
import { userService } from '../services/user-service';
import { scriptService } from '../services/script-service';
import { scriptVersionService } from '../services/script-version-service';
import { assetService } from '../services/asset-service';
import { __setAssetStorageForTesting, type AssetStorage } from '../services/asset-storage';
import { assertTestDatabase } from './_db-guard';
import type { ScriptManifest } from '../../../src/core/types';

// ============================================================================
// 内存 AssetStorage mock（上传/下载/删除都走 Map，不走 S3）
// ============================================================================

interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
  metadata?: Record<string, string>;
}

function makeMemoryStorage(): AssetStorage & { bucket: Map<string, StoredObject> } {
  const bucket = new Map<string, StoredObject>();
  return {
    bucket,
    async put(key, body, contentType, metadata) {
      // body 可能是 Web ReadableStream（我们的 upload 走这条），读完收集字节
      let bytes: Uint8Array;
      if (body instanceof ReadableStream) {
        const reader = body.getReader();
        const chunks: Uint8Array[] = [];
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        const total = chunks.reduce((n, c) => n + c.length, 0);
        bytes = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
          bytes.set(c, off);
          off += c.length;
        }
      } else {
        // Node Readable — test 路径不会用，兜底占位
        bytes = new Uint8Array();
      }
      bucket.set(key, {
        bytes,
        contentType: contentType ?? 'application/octet-stream',
        metadata,
      });
    },
    async get(key) {
      const obj = bucket.get(key);
      if (!obj) return null;
      return {
        stream: new Blob([obj.bytes as unknown as BlobPart]).stream(),
        contentType: obj.contentType,
        contentLength: obj.bytes.byteLength,
      };
    },
    async delete(key) {
      bucket.delete(key);
    },
    async head(key) {
      const obj = bucket.get(key);
      if (!obj) return null;
      return { contentType: obj.contentType, contentLength: obj.bytes.byteLength };
    },
  };
}

const memStorage = makeMemoryStorage();
__setAssetStorageForTesting(memStorage);
afterAll(() => {
  __setAssetStorageForTesting(null);
});

/** 1x1 透明 PNG，base64 编码。用于 upload 测试 —— 最小可识别 PNG */
const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// ============================================================================
// Fixtures
// ============================================================================

async function cleanTables() {
  await assertTestDatabase();
  await db.delete(schema.narrativeEntries);
  await db.delete(schema.playthroughs);
  await db.delete(schema.scriptAssets);
  await db.delete(schema.scriptVersions);
  await db.delete(schema.scripts);
  await db.delete(schema.userSessions);
  await db.delete(schema.users);
  await db.delete(schema.llmConfigs);
  // 清空内存 bucket，避免跨 test 污染
  memStorage.bucket.clear();
}

async function ensureRolesSeeded() {
  await db
    .insert(schema.roles)
    .values([
      { id: 'user', name: '普通用户' },
      { id: 'admin', name: '管理员' },
    ])
    .onConflictDoNothing({ target: schema.roles.id });
}

async function createTestAdmin(): Promise<{ userId: string; sessionId: string }> {
  await ensureRolesSeeded();
  const userId = crypto.randomUUID();
  const sessionId = crypto.randomUUID();
  await db.insert(schema.users).values({
    id: userId,
    username: `mcp-admin-${userId.slice(0, 8)}`,
    passwordHash: 'n/a',
    displayName: 'mcp admin',
    roleId: 'admin',
  });
  await db.insert(schema.userSessions).values({
    id: sessionId,
    userId,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  return { userId, sessionId };
}

function minimalManifest(id: string): ScriptManifest {
  return {
    id,
    label: 'test script',
    chapters: [
      {
        id: 'ch1',
        label: 'Chapter 1',
        flowGraph: { nodes: [], edges: [] } as unknown as ScriptManifest['chapters'][number]['flowGraph'],
        segments: [
          {
            id: 'seg-1',
            label: '主系统提示',
            content: 'original content',
            contentHash: 'deadbeef',
            type: 'content',
            sourceDoc: 'test.md',
            role: 'system',
            priority: 0,
            tokenCount: 2,
          },
        ],
      },
    ],
    stateSchema: { variables: [] },
    memoryConfig: {
      contextBudget: 4000,
      compressionThreshold: 3000,
      recencyWindow: 20,
    },
    enabledTools: [],
  };
}

/** 构造一个 JSON-RPC 请求，POST 到 /api/mcp */
async function jrpc(
  app: ReturnType<typeof buildApp>,
  sessionId: string | null,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (sessionId) headers['Authorization'] = `Bearer ${sessionId}`;
  const res = await app.handle(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: res.status, json: parsed };
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(async () => {
  await cleanTables();
});

describe('mcp route', () => {
  it('returns 403 without Authorization', async () => {
    const app = buildApp();
    const { status } = await jrpc(app, null, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    expect(status).toBe(403);
  });

  it('returns 403 for non-admin session', async () => {
    const app = buildApp();
    const { sessionId } = await userService.createAnonymous();
    const { status } = await jrpc(app, sessionId, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });
    expect(status).toBe(403);
  });

  it('handles initialize', async () => {
    const app = buildApp();
    const { sessionId } = await createTestAdmin();
    const { status, json } = await jrpc(app, sessionId, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', clientInfo: { name: 'test', version: '0' } },
    });
    expect(status).toBe(200);
    const body = json as { jsonrpc: string; id: number; result: { protocolVersion: string; serverInfo: { name: string }; capabilities: { tools: object } } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.serverInfo.name).toBe('ivn-engine-scripts');
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it('handles tools/list', async () => {
    const app = buildApp();
    const { sessionId } = await createTestAdmin();
    const { status, json } = await jrpc(app, sessionId, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    expect(status).toBe(200);
    const body = json as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain('list_scripts');
    expect(names).toContain('get_script_overview');
    expect(names).toContain('get_segment');
    expect(names).toContain('get_full_manifest');
    expect(names).toContain('update_segment_content');
    expect(names).toContain('replace_script_manifest');
    expect(names).toContain('publish_script_version');
    expect(names).toContain('list_script_versions');
  });

  it('returns 202 with empty body for notifications', async () => {
    const app = buildApp();
    const { sessionId } = await createTestAdmin();
    const res = await app.handle(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionId}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }),
      }),
    );
    expect(res.status).toBe(202);
    const text = await res.text();
    expect(text).toBe('');
  });

  it('returns 400 for malformed JSON-RPC', async () => {
    const app = buildApp();
    const { sessionId } = await createTestAdmin();
    const { status, json } = await jrpc(app, sessionId, {
      // missing jsonrpc field
      id: 3,
      method: 'initialize',
    });
    expect(status).toBe(400);
    const body = json as { error: { code: number } };
    expect(body.error.code).toBe(-32600);
  });

  it('tools/call list_scripts returns empty on empty db', async () => {
    const app = buildApp();
    const { sessionId } = await createTestAdmin();
    const { status, json } = await jrpc(app, sessionId, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'list_scripts', arguments: {} },
    });
    expect(status).toBe(200);
    const body = json as { result: { content: Array<{ type: string; text: string }> } };
    const text = body.result.content[0]!.text;
    const parsed = JSON.parse(text) as { scripts: unknown[] };
    expect(parsed.scripts.length).toBe(0);
  });

  it('tools/call returns isError: true for unknown tool args', async () => {
    const app = buildApp();
    const { sessionId } = await createTestAdmin();
    const { status, json } = await jrpc(app, sessionId, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'get_script_overview',
        arguments: { scriptId: 'nonexistent' },
      },
    });
    expect(status).toBe(200);
    const body = json as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain('Script not found');
  });

  it('tools/call update_segment_content writes a new draft', async () => {
    const app = buildApp();
    const { userId, sessionId } = await createTestAdmin();

    // seed: 1 script + 1 published version with one segment
    const scriptId = crypto.randomUUID();
    await scriptService.create({
      id: scriptId,
      authorUserId: userId,
      label: 'test script',
    });
    const baseManifest = minimalManifest(scriptId);
    await scriptVersionService.create({
      scriptId,
      manifest: baseManifest,
      status: 'published',
    });

    // invoke MCP update_segment_content
    const { status, json } = await jrpc(app, sessionId, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'update_segment_content',
        arguments: {
          scriptId,
          chapterId: 'ch1',
          segmentId: 'seg-1',
          newContent: 'updated content via mcp',
          versionNote: 'test edit',
        },
      },
    });
    expect(status).toBe(200);
    const body = json as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBeUndefined();
    const payload = JSON.parse(body.result.content[0]!.text) as {
      newVersionId: string;
      created: boolean;
      segment: { oldContentLength: number; newContentLength: number };
    };
    expect(payload.created).toBe(true);
    expect(payload.newVersionId).toBeTruthy();
    expect(payload.segment.oldContentLength).toBe('original content'.length);
    expect(payload.segment.newContentLength).toBe('updated content via mcp'.length);

    // verify DB: should now have 2 versions (v1 published, v2 draft)
    const versions = await scriptVersionService.listByScript(scriptId);
    expect(versions.length).toBe(2);
    const draft = versions.find((v) => v.status === 'draft');
    expect(draft).toBeDefined();
    expect(draft!.id).toBe(payload.newVersionId);

    // verify content actually updated
    const draftFull = await scriptVersionService.getById(draft!.id);
    expect(draftFull!.manifest.chapters[0]!.segments[0]!.content).toBe('updated content via mcp');
  });

  it('tools/call publish_script_version promotes draft → published', async () => {
    const app = buildApp();
    const { userId, sessionId } = await createTestAdmin();

    const scriptId = crypto.randomUUID();
    await scriptService.create({ id: scriptId, authorUserId: userId, label: 'pub test' });
    const draft = await scriptVersionService.create({
      scriptId,
      manifest: minimalManifest(scriptId),
      status: 'draft',
    });

    const { status, json } = await jrpc(app, sessionId, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'publish_script_version',
        arguments: { versionId: draft.version.id },
      },
    });
    expect(status).toBe(200);
    const body = json as { result: { isError?: boolean } };
    expect(body.result.isError).toBeUndefined();

    const published = await scriptVersionService.getCurrentPublished(scriptId);
    expect(published!.id).toBe(draft.version.id);
    expect(published!.status).toBe('published');
  });

  // --------------------------------------------------------------------------
  // Asset upload tools
  // --------------------------------------------------------------------------

  it('tools/list includes asset tools', async () => {
    const app = buildApp();
    const { sessionId } = await createTestAdmin();
    const { json } = await jrpc(app, sessionId, {
      jsonrpc: '2.0',
      id: 100,
      method: 'tools/list',
    });
    const body = json as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain('list_script_assets');
    expect(names).toContain('upload_script_asset');
    expect(names).toContain('add_background_to_script');
    expect(names).toContain('add_character_sprite');
  });

  it('upload_script_asset uploads bytes + records DB row but does not touch manifest', async () => {
    const app = buildApp();
    const { userId, sessionId } = await createTestAdmin();
    const scriptId = crypto.randomUUID();
    await scriptService.create({ id: scriptId, authorUserId: userId, label: 'asset test' });
    await scriptVersionService.create({
      scriptId,
      manifest: minimalManifest(scriptId),
      status: 'published',
    });
    const versionsBefore = await scriptVersionService.listByScript(scriptId);

    const { status, json } = await jrpc(app, sessionId, {
      jsonrpc: '2.0',
      id: 101,
      method: 'tools/call',
      params: {
        name: 'upload_script_asset',
        arguments: {
          scriptId,
          kind: 'sprite',
          contentType: 'image/png',
          imageBase64: TINY_PNG_B64,
        },
      },
    });
    expect(status).toBe(200);
    const body = json as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBeUndefined();
    const payload = JSON.parse(body.result.content[0]!.text) as {
      assetId: string;
      assetUrl: string;
      storageKey: string;
      sizeBytes: number;
      kind: string;
    };
    expect(payload.kind).toBe('sprite');
    expect(payload.assetUrl).toBe(`/api/assets/${payload.storageKey}`);
    expect(payload.sizeBytes).toBeGreaterThan(0);

    // storage + DB 都落地
    expect(memStorage.bucket.has(payload.storageKey)).toBe(true);
    const row = await assetService.getByKey(payload.storageKey);
    expect(row).not.toBeNull();
    expect(row!.scriptId).toBe(scriptId);
    expect(row!.contentType).toBe('image/png');

    // 没有新建 script version
    const versionsAfter = await scriptVersionService.listByScript(scriptId);
    expect(versionsAfter.length).toBe(versionsBefore.length);
  });

  it('upload_script_asset rejects oversized payload', async () => {
    const app = buildApp();
    const { userId, sessionId } = await createTestAdmin();
    const scriptId = crypto.randomUUID();
    await scriptService.create({ id: scriptId, authorUserId: userId, label: 't' });
    await scriptVersionService.create({
      scriptId,
      manifest: minimalManifest(scriptId),
      status: 'published',
    });

    // 11 MB 的 base64（对应约 8MB 原始；稍微多点保证超过 10MB 阈值）
    // 其实为了打满 10MB raw，需要 base64 长度 ~14MB。我们用 ~15MB base64
    const bigRaw = new Uint8Array(11 * 1024 * 1024);
    const bigB64 = Buffer.from(bigRaw).toString('base64');

    const { status, json } = await jrpc(app, sessionId, {
      jsonrpc: '2.0',
      id: 102,
      method: 'tools/call',
      params: {
        name: 'upload_script_asset',
        arguments: {
          scriptId,
          kind: 'background',
          contentType: 'image/png',
          imageBase64: bigB64,
        },
      },
    });
    expect(status).toBe(200);
    const body = json as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain('too large');
  });

  it('upload_script_asset rejects disallowed contentType', async () => {
    const app = buildApp();
    const { userId, sessionId } = await createTestAdmin();
    const scriptId = crypto.randomUUID();
    await scriptService.create({ id: scriptId, authorUserId: userId, label: 't' });
    await scriptVersionService.create({
      scriptId,
      manifest: minimalManifest(scriptId),
      status: 'published',
    });

    const { json } = await jrpc(app, sessionId, {
      jsonrpc: '2.0',
      id: 103,
      method: 'tools/call',
      params: {
        name: 'upload_script_asset',
        arguments: {
          scriptId,
          kind: 'sprite',
          contentType: 'application/pdf',
          imageBase64: TINY_PNG_B64,
        },
      },
    });
    const body = json as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain('Unsupported contentType');
  });

  it('add_background_to_script uploads + adds to manifest.backgrounds + creates new draft', async () => {
    const app = buildApp();
    const { userId, sessionId } = await createTestAdmin();
    const scriptId = crypto.randomUUID();
    await scriptService.create({ id: scriptId, authorUserId: userId, label: 'bg test' });
    await scriptVersionService.create({
      scriptId,
      manifest: minimalManifest(scriptId),
      status: 'published',
    });

    const { status, json } = await jrpc(app, sessionId, {
      jsonrpc: '2.0',
      id: 104,
      method: 'tools/call',
      params: {
        name: 'add_background_to_script',
        arguments: {
          scriptId,
          backgroundId: 'classroom_evening',
          label: '教室·黄昏',
          contentType: 'image/png',
          imageBase64: TINY_PNG_B64,
        },
      },
    });
    expect(status).toBe(200);
    const body = json as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBeUndefined();
    const payload = JSON.parse(body.result.content[0]!.text) as {
      replaced: boolean;
      assetUrl: string;
      newVersionId: string;
    };
    expect(payload.replaced).toBe(false);
    expect(payload.assetUrl).toContain('/api/assets/scripts/');

    // 新 draft 里 backgrounds 有这条
    const draft = await scriptVersionService.getById(payload.newVersionId);
    expect(draft!.status).toBe('draft');
    const bgs = draft!.manifest.backgrounds ?? [];
    expect(bgs.length).toBe(1);
    expect(bgs[0]!.id).toBe('classroom_evening');
    expect(bgs[0]!.label).toBe('教室·黄昏');
    expect(bgs[0]!.assetUrl).toBe(payload.assetUrl);
  });

  it('add_background_to_script with existing id replaces assetUrl', async () => {
    const app = buildApp();
    const { userId, sessionId } = await createTestAdmin();
    const scriptId = crypto.randomUUID();
    await scriptService.create({ id: scriptId, authorUserId: userId, label: 't' });
    const initial = minimalManifest(scriptId);
    initial.backgrounds = [
      { id: 'classroom_evening', assetUrl: '/api/assets/old', label: '旧' },
    ];
    await scriptVersionService.create({ scriptId, manifest: initial, status: 'published' });

    const { json } = await jrpc(app, sessionId, {
      jsonrpc: '2.0',
      id: 105,
      method: 'tools/call',
      params: {
        name: 'add_background_to_script',
        arguments: {
          scriptId,
          backgroundId: 'classroom_evening',
          contentType: 'image/png',
          imageBase64: TINY_PNG_B64,
        },
      },
    });
    const body = json as { result: { isError?: boolean; content: Array<{ text: string }> } };
    const payload = JSON.parse(body.result.content[0]!.text) as {
      replaced: boolean;
      assetUrl: string;
      newVersionId: string;
    };
    expect(payload.replaced).toBe(true);
    const draft = await scriptVersionService.getById(payload.newVersionId);
    const bgs = draft!.manifest.backgrounds ?? [];
    expect(bgs.length).toBe(1);
    expect(bgs[0]!.assetUrl).toBe(payload.assetUrl);
    expect(bgs[0]!.assetUrl).not.toBe('/api/assets/old');
    // 未传 label 时保留旧 label
    expect(bgs[0]!.label).toBe('旧');
  });

  it('add_character_sprite creates character on first call', async () => {
    const app = buildApp();
    const { userId, sessionId } = await createTestAdmin();
    const scriptId = crypto.randomUUID();
    await scriptService.create({ id: scriptId, authorUserId: userId, label: 't' });
    await scriptVersionService.create({
      scriptId,
      manifest: minimalManifest(scriptId),
      status: 'published',
    });

    // 1. 角色不存在 + 没给 displayName → isError
    {
      const { json } = await jrpc(app, sessionId, {
        jsonrpc: '2.0',
        id: 106,
        method: 'tools/call',
        params: {
          name: 'add_character_sprite',
          arguments: {
            scriptId,
            characterId: 'aonkei',
            spriteId: 'smiling',
            contentType: 'image/png',
            imageBase64: TINY_PNG_B64,
          },
        },
      });
      const body = json as { result: { isError?: boolean; content: Array<{ text: string }> } };
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0]!.text).toContain('characterDisplayName');
    }

    // 2. 带上 displayName → 创建 character + 加 sprite
    {
      const { json } = await jrpc(app, sessionId, {
        jsonrpc: '2.0',
        id: 107,
        method: 'tools/call',
        params: {
          name: 'add_character_sprite',
          arguments: {
            scriptId,
            characterId: 'aonkei',
            characterDisplayName: '昂晴',
            spriteId: 'smiling',
            spriteLabel: '微笑',
            contentType: 'image/png',
            imageBase64: TINY_PNG_B64,
          },
        },
      });
      const body = json as { result: { isError?: boolean; content: Array<{ text: string }> } };
      expect(body.result.isError).toBeUndefined();
      const payload = JSON.parse(body.result.content[0]!.text) as {
        createdCharacter: boolean;
        replacedSprite: boolean;
        newVersionId: string;
        assetUrl: string;
      };
      expect(payload.createdCharacter).toBe(true);
      expect(payload.replacedSprite).toBe(false);

      const draft = await scriptVersionService.getById(payload.newVersionId);
      const chars = draft!.manifest.characters ?? [];
      expect(chars.length).toBe(1);
      expect(chars[0]!.id).toBe('aonkei');
      expect(chars[0]!.displayName).toBe('昂晴');
      expect(chars[0]!.sprites.length).toBe(1);
      expect(chars[0]!.sprites[0]!.id).toBe('smiling');
      expect(chars[0]!.sprites[0]!.label).toBe('微笑');
      expect(chars[0]!.sprites[0]!.assetUrl).toBe(payload.assetUrl);
    }

    // 3. 再加一张同角色不同 sprite → append
    {
      const { json } = await jrpc(app, sessionId, {
        jsonrpc: '2.0',
        id: 108,
        method: 'tools/call',
        params: {
          name: 'add_character_sprite',
          arguments: {
            scriptId,
            characterId: 'aonkei',
            spriteId: 'crying',
            contentType: 'image/png',
            imageBase64: TINY_PNG_B64,
          },
        },
      });
      const body = json as { result: { isError?: boolean; content: Array<{ text: string }> } };
      expect(body.result.isError).toBeUndefined();
      const payload = JSON.parse(body.result.content[0]!.text) as {
        createdCharacter: boolean;
        replacedSprite: boolean;
        newVersionId: string;
      };
      expect(payload.createdCharacter).toBe(false);
      expect(payload.replacedSprite).toBe(false);

      const draft = await scriptVersionService.getById(payload.newVersionId);
      const sprites = draft!.manifest.characters![0]!.sprites;
      expect(sprites.length).toBe(2);
      expect(sprites.map((s) => s.id).sort()).toEqual(['crying', 'smiling']);
    }

    // 4. 覆盖已有 sprite
    {
      const { json } = await jrpc(app, sessionId, {
        jsonrpc: '2.0',
        id: 109,
        method: 'tools/call',
        params: {
          name: 'add_character_sprite',
          arguments: {
            scriptId,
            characterId: 'aonkei',
            spriteId: 'smiling',
            contentType: 'image/webp',
            imageBase64: TINY_PNG_B64,
          },
        },
      });
      const body = json as { result: { isError?: boolean; content: Array<{ text: string }> } };
      expect(body.result.isError).toBeUndefined();
      const payload = JSON.parse(body.result.content[0]!.text) as { replacedSprite: boolean };
      expect(payload.replacedSprite).toBe(true);
    }
  });

  it('list_script_assets returns uploaded rows', async () => {
    const app = buildApp();
    const { userId, sessionId } = await createTestAdmin();
    const scriptId = crypto.randomUUID();
    await scriptService.create({ id: scriptId, authorUserId: userId, label: 't' });
    await scriptVersionService.create({
      scriptId,
      manifest: minimalManifest(scriptId),
      status: 'published',
    });

    // 先上传一张
    await jrpc(app, sessionId, {
      jsonrpc: '2.0',
      id: 110,
      method: 'tools/call',
      params: {
        name: 'upload_script_asset',
        arguments: {
          scriptId,
          kind: 'sprite',
          contentType: 'image/png',
          imageBase64: TINY_PNG_B64,
        },
      },
    });

    const { json } = await jrpc(app, sessionId, {
      jsonrpc: '2.0',
      id: 111,
      method: 'tools/call',
      params: { name: 'list_script_assets', arguments: { scriptId } },
    });
    const body = json as { result: { content: Array<{ text: string }> } };
    const payload = JSON.parse(body.result.content[0]!.text) as {
      assets: Array<{ assetUrl: string; kind: string }>;
    };
    expect(payload.assets.length).toBe(1);
    expect(payload.assets[0]!.kind).toBe('sprite');
    expect(payload.assets[0]!.assetUrl).toContain('/api/assets/scripts/');
  });

  it('accepts data: URL prefix in imageBase64', async () => {
    const app = buildApp();
    const { userId, sessionId } = await createTestAdmin();
    const scriptId = crypto.randomUUID();
    await scriptService.create({ id: scriptId, authorUserId: userId, label: 't' });
    await scriptVersionService.create({
      scriptId,
      manifest: minimalManifest(scriptId),
      status: 'published',
    });

    const { json } = await jrpc(app, sessionId, {
      jsonrpc: '2.0',
      id: 112,
      method: 'tools/call',
      params: {
        name: 'upload_script_asset',
        arguments: {
          scriptId,
          kind: 'background',
          contentType: 'image/png',
          imageBase64: `data:image/png;base64,${TINY_PNG_B64}`,
        },
      },
    });
    const body = json as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // delete_script tool
  // --------------------------------------------------------------------------

  it('tools/list includes delete_script', async () => {
    const app = buildApp();
    const { sessionId } = await createTestAdmin();
    const { json } = await jrpc(app, sessionId, {
      jsonrpc: '2.0',
      id: 200,
      method: 'tools/list',
    });
    const body = json as { result: { tools: Array<{ name: string }> } };
    const names = body.result.tools.map((t) => t.name);
    expect(names).toContain('delete_script');
  });

  it('delete_script without confirm returns dry-run with impact summary', async () => {
    const app = buildApp();
    const { userId, sessionId } = await createTestAdmin();
    const scriptId = crypto.randomUUID();
    await scriptService.create({ id: scriptId, authorUserId: userId, label: 'to-delete' });
    await scriptVersionService.create({
      scriptId,
      manifest: minimalManifest(scriptId),
      status: 'published',
    });

    const { status, json } = await jrpc(app, sessionId, {
      jsonrpc: '2.0',
      id: 201,
      method: 'tools/call',
      params: { name: 'delete_script', arguments: { scriptId } },
    });
    expect(status).toBe(200);
    const body = json as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBeUndefined();
    const payload = JSON.parse(body.result.content[0]!.text) as {
      dryRun: boolean;
      wouldDelete: { scriptId: string; versionCount: number };
    };
    expect(payload.dryRun).toBe(true);
    expect(payload.wouldDelete.scriptId).toBe(scriptId);
    expect(payload.wouldDelete.versionCount).toBe(1);

    // 剧本仍然存在
    const stillHere = await scriptService.getById(scriptId);
    expect(stillHere).not.toBeNull();
  });

  it('delete_script with confirm=true but mismatched scriptIdConfirm → isError', async () => {
    const app = buildApp();
    const { userId, sessionId } = await createTestAdmin();
    const scriptId = crypto.randomUUID();
    await scriptService.create({ id: scriptId, authorUserId: userId, label: 'safety' });

    const { json } = await jrpc(app, sessionId, {
      jsonrpc: '2.0',
      id: 202,
      method: 'tools/call',
      params: {
        name: 'delete_script',
        arguments: { scriptId, confirm: true, scriptIdConfirm: 'wrong-id' },
      },
    });
    const body = json as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain('Safety check failed');

    // 剧本仍然存在
    const stillHere = await scriptService.getById(scriptId);
    expect(stillHere).not.toBeNull();
  });

  it('delete_script with confirm=true + matching scriptIdConfirm deletes script + cascades versions', async () => {
    const app = buildApp();
    const { userId, sessionId } = await createTestAdmin();
    const scriptId = crypto.randomUUID();
    await scriptService.create({ id: scriptId, authorUserId: userId, label: 'bye' });
    await scriptVersionService.create({
      scriptId,
      manifest: minimalManifest(scriptId),
      status: 'published',
    });
    await scriptVersionService.create({
      scriptId,
      manifest: { ...minimalManifest(scriptId), label: 'v2' },
      status: 'draft',
    });

    const { status, json } = await jrpc(app, sessionId, {
      jsonrpc: '2.0',
      id: 203,
      method: 'tools/call',
      params: {
        name: 'delete_script',
        arguments: { scriptId, confirm: true, scriptIdConfirm: scriptId },
      },
    });
    expect(status).toBe(200);
    const body = json as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBeUndefined();
    const payload = JSON.parse(body.result.content[0]!.text) as {
      ok: boolean;
      deleted: { scriptId: string; versionCount: number };
      warning: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.deleted.scriptId).toBe(scriptId);
    expect(payload.deleted.versionCount).toBe(2);
    expect(payload.warning).toContain('OSS');

    // script + versions 都没了
    expect(await scriptService.getById(scriptId)).toBeNull();
    const remainingVersions = await scriptVersionService.listByScript(scriptId);
    expect(remainingVersions.length).toBe(0);
  });

  it('delete_script on nonexistent id → isError', async () => {
    const app = buildApp();
    const { sessionId } = await createTestAdmin();
    const { json } = await jrpc(app, sessionId, {
      jsonrpc: '2.0',
      id: 204,
      method: 'tools/call',
      params: {
        name: 'delete_script',
        arguments: {
          scriptId: 'does-not-exist-' + crypto.randomUUID(),
          confirm: true,
          scriptIdConfirm: 'does-not-exist',
        },
      },
    });
    const body = json as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain('Script not found');
  });
});
