/**
 * IVN Server — Elysia 后端入口
 *
 * 职责：
 *   1. 托管前端静态资源（Vite 构建产物，直接 serve 已编译文件）
 *   2. 剧本存储（编剧发布 / 玩家读取 catalog）
 *   3. 游玩会话（GameSession 在后端运行，通过 WebSocket 推流）
 *
 * 注意：不使用 @elysiajs/static，因为 Bun 1.3+ 的 staticPlugin 会
 * 触发 fullstack dev server 行为（尝试 bundle HTML），与已构建好的
 * Vite 产物冲突。改用 Bun.file() 直接 serve 静态文件。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '#internal/app';
import { testConnection, runMigrations, closePool } from '#internal/db';
import { shutdownTracing } from '#internal/tracing';
import { llmConfigService } from '#internal/services/llm-config-service';
import { getServerEnv } from '#internal/env';
import { createLlmConfigSeedFromEnv } from '@ivn/specification/env';

const env = getServerEnv();
const PORT = env.PORT;

// 前端构建产物路径：apps/ui/dist
const DIST_DIR = fileURLToPath(new URL('../../ui/dist', import.meta.url));
const HAS_DIST = existsSync(DIST_DIR);

// MIME 类型映射
const MIME_MAP: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
};

// Elysia app 在 ./app.mts 里构造（纯函数 buildApp），供 tests 复用
const app = buildApp();

// 托管前端静态资源（仅在 dist/ 存在时启用）
if (HAS_DIST) {
  // 静态文件：直接 serve dist/ 中的文件
  app.get('/assets/*', ({ params }) => {
    const filePath = join(DIST_DIR, 'assets', params['*']);
    const file = Bun.file(filePath);
    const ext = extname(filePath);
    return new Response(file, {
      headers: {
        'Content-Type': MIME_MAP[ext] ?? 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable', // Vite 哈希文件名，可长期缓存
      },
    });
  });

  // SPA fallback: 非 API 的 404 路由返回 index.html
  app.onError(({ request, code }) => {
    if (code === 'NOT_FOUND') {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/') && url.pathname !== '/health') {
        return new Response(Bun.file(join(DIST_DIR, 'index.html')), {
          headers: { 'Content-Type': 'text/html' },
        });
      }
    }
  });

  console.log(`📦 Serving frontend from ${DIST_DIR}`);
} else {
  console.log(`⚠️  No dist/ found — run 'pnpm build' in project root to enable frontend hosting`);
}

/**
 * v2.7 bootstrap：如果 llm_configs 表空的，从旧 JSON 文件 / 环境变量
 * 自动 seed 一条默认配置。让全新部署零手动步骤；已有部署也能从老的
 * llm-config.json 平滑过渡。
 */
async function bootstrapDefaultLlmConfig() {
  const existing = await llmConfigService.listAll();
  if (existing.length > 0) return;

  // 1. 试读旧的 apps/server/data/llm-config.json（6.2 时代的单 config 文件）
  const legacyPath = fileURLToPath(new URL('../data/llm-config.json', import.meta.url));
  let seed: {
    provider: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    name: string;
    thinkingEnabled: boolean | null;
    reasoningEffort: 'high' | 'max' | null;
  } | null = null;

  if (existsSync(legacyPath)) {
    try {
      const raw = readFileSync(legacyPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.apiKey) {
        const thinkingEnabledRaw = parsed.thinkingEnabled;
        const reasoningEffortRaw = parsed.reasoningEffort;
        seed = {
          provider: parsed.provider ?? 'openai-compatible',
          baseUrl: parsed.baseUrl ?? 'https://api.deepseek.com/v1',
          apiKey: parsed.apiKey,
          model: parsed.model ?? 'deepseek-chat',
          name: parsed.name ?? 'default',
          thinkingEnabled: typeof thinkingEnabledRaw === 'boolean' ? thinkingEnabledRaw : null,
          reasoningEffort:
            reasoningEffortRaw === 'high' || reasoningEffortRaw === 'max'
              ? reasoningEffortRaw
              : null,
        };
      }
    } catch (err) {
      console.warn('[bootstrap] failed to read legacy llm-config.json:', err);
    }
  }

  // 2. fallback 到环境变量
  seed ??= createLlmConfigSeedFromEnv(env);

  if (!seed) {
    console.warn('[bootstrap] llm_configs 表空，但未找到 env/json 种子。' +
      '首次使用前请通过 /api/llm-configs 创建至少一条配置。');
    return;
  }

  await llmConfigService.create(seed);
  console.log(`[bootstrap] seeded initial llm_config: name="${seed.name}" model="${seed.model}"`);
}

// 启动时：测试 DB 连接 + 应用待执行的迁移 + 启动 HTTP 服务
async function startup() {
  try {
    await testConnection();
    await runMigrations();
    await bootstrapDefaultLlmConfig();
  } catch (err) {
    console.error('[startup] DB initialization failed:', err);
    console.error('[startup] 如果线上首次部署，请先运行:');
    console.error('  bun run scripts/migrate-player-identity.mts   # 升级老 schema');
    console.error('  bun run scripts/bootstrap-drizzle-migrations.mts   # 标记 baseline');
    console.error('[startup] 拒绝启动服务，避免半残状态');
    process.exit(1);
  }

  app.listen(PORT);
  console.log(`🎭 IVN Server running at http://localhost:${PORT}`);
}

// graceful shutdown：flush Langfuse pending traces + 关闭 DB 连接
async function gracefulShutdown(signal: string) {
  console.log(`\n[shutdown] Received ${signal}, flushing and closing...`);
  try {
    await shutdownTracing();
    await closePool();
  } catch (err) {
    console.error('[shutdown] error:', err);
  }
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

startup();

export type App = typeof app;
