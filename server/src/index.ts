/**
 * IVN Server — Elysia 后端入口
 *
 * 职责：
 *   1. 托管前端静态资源（Vite 构建产物）
 *   2. 剧本存储（编剧发布 / 玩家读取 catalog）
 *   3. 游玩会话（GameSession 在后端运行，通过 WebSocket 推流）
 */

import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { staticPlugin } from '@elysiajs/static';
import { existsSync } from 'fs';
import { join } from 'path';
import { scriptRoutes } from './routes/scripts';
import { sessionRoutes } from './routes/sessions';

const PORT = Number(process.env.PORT) || 3001;

// 前端构建产物路径：项目根目录的 dist/
const DIST_DIR = join(import.meta.dir, '../../dist');

const app = new Elysia()
  .use(cors())
  .use(scriptRoutes)
  .use(sessionRoutes)
  .get('/health', () => ({ ok: true, timestamp: Date.now() }));

// 托管前端静态资源（仅在 dist/ 存在时启用）
if (existsSync(DIST_DIR)) {
  app.use(staticPlugin({ assets: DIST_DIR, prefix: '/' }));
  // SPA fallback: 非 API/静态文件的请求返回 index.html
  app.get('*', () => Bun.file(join(DIST_DIR, 'index.html')));
  console.log(`📦 Serving frontend from ${DIST_DIR}`);
} else {
  console.log(`⚠️  No dist/ found — run 'pnpm build' in project root to enable frontend hosting`);
}

app.listen(PORT);

console.log(`🎭 IVN Server running at http://localhost:${PORT}`);

export type App = typeof app;
