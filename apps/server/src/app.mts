/**
 * App Builder — 构造 Elysia app（纯函数，不绑端口、不连 DB）
 *
 * 抽出来供 server entry（index.ts）和 tests 共用：
 * - index.ts: buildApp() + app.listen() 启动服务
 * - tests:    buildApp() + app.handle() 触发路由树构建，验证路由配置
 *
 * 目的：让"路由参数命名冲突 / 重复路由 / 缺 plugin"这类启动期错误能在
 * 测试阶段被发现，而不是要等到生产部署 startup 时才暴露。
 *
 * 这个模块**不能** import 任何会执行副作用的东西（DB 连接 / 信号处理器
 * / process.exit 等），否则 test import 会触发副作用。
 */

import { Elysia } from 'elysia';
import { cors } from '@elysiajs/cors';
import { scriptRoutes } from '#internal/routes/scripts';
import { scriptVersionsForScriptRoutes, scriptVersionRoutes } from '#internal/routes/script-versions';
import { sessionRoutes } from '#internal/routes/sessions';
import { llmConfigRoutes } from '#internal/routes/llm-configs';
import { authRoutes } from '#internal/routes/auth';
import { playthroughRoutes } from '#internal/routes/playthroughs';
import { assetRoutes } from '#internal/routes/assets';
import { mcpRoutes } from '#internal/routes/mcp';
import { feedbackRoutes } from '#internal/routes/feedback';
import { bugReportRoutes } from '#internal/routes/bug-reports';
import { buildOpRouter } from '#internal/operations/adapters/http';
import { ALL_OPS } from '#internal/operations/registry';

export function buildApp() {
  return new Elysia()
    .use(cors())
    .use(scriptRoutes)
    .use(scriptVersionsForScriptRoutes)
    .use(scriptVersionRoutes)
    .use(sessionRoutes)
    .use(llmConfigRoutes)
    .use(authRoutes)
    .use(playthroughRoutes)
    .use(assetRoutes)
    .use(mcpRoutes)
    .use(feedbackRoutes)
    .use(bugReportRoutes)
    .use(buildOpRouter(ALL_OPS))
    .get('/health', () => ({ ok: true, timestamp: Date.now() }));
}

export type App = ReturnType<typeof buildApp>;
