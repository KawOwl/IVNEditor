/**
 * IVN Server — Elysia 后端入口
 *
 * 职责：
 *   1. 剧本存储（编剧发布 / 玩家读取 catalog）
 *   2. 游玩会话（GameSession 在后端运行，通过 WebSocket 推流）
 */

import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { scriptRoutes } from './routes/scripts';
import { sessionRoutes } from './routes/sessions';

const PORT = Number(process.env.PORT) || 3001;

const app = new Elysia()
  .use(cors())
  .use(scriptRoutes)
  .use(sessionRoutes)
  .get('/health', () => ({ ok: true, timestamp: Date.now() }))
  .listen(PORT);

console.log(`🎭 IVN Server running at http://localhost:${PORT}`);

export type App = typeof app;
