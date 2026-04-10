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

import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { existsSync } from 'fs';
import { join, extname } from 'path';
import { scriptRoutes } from './routes/scripts';
import { sessionRoutes } from './routes/sessions';
import { configRoutes } from './routes/config';
import { authRoutes } from './routes/auth';
import { playthroughRoutes } from './routes/playthroughs';
import { testConnection, runMigrations, closePool } from './db';
import { shutdownTracing } from './tracing';

const PORT = Number(process.env.PORT) || 3001;

// 前端构建产物路径：项目根目录的 dist/
const DIST_DIR = join(import.meta.dir, '../../dist');
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

const app = new Elysia()
  .use(cors())
  .use(scriptRoutes)
  .use(sessionRoutes)
  .use(configRoutes)
  .use(authRoutes)
  .use(playthroughRoutes)
  .get('/health', () => ({ ok: true, timestamp: Date.now() }));

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

// 启动时：测试 DB 连接 + 应用待执行的迁移 + 启动 HTTP 服务
async function startup() {
  try {
    await testConnection();
    await runMigrations();
  } catch (err) {
    console.error('[startup] DB initialization failed:', err);
    console.error('[startup] 如果线上首次部署，请先运行:');
    console.error('  bun run scripts/migrate-player-identity.ts   # 升级老 schema');
    console.error('  bun run scripts/bootstrap-drizzle-migrations.ts   # 标记 baseline');
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
