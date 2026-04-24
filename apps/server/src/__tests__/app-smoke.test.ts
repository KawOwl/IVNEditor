/**
 * App Startup Smoke Test — 保证 Elysia app 能成功构造
 *
 * 目的：捕获"启动期路由树构建错误"这类问题，例如：
 * - 同一路径位置出现不同名字的参数（memoirist 会抛 "different parameter
 *   name" 错误）
 * - 重复挂载同一路由
 * - plugin 依赖链缺失
 *
 * 实现：import 纯函数 buildApp → 构造 app → 调一次 app.handle() 触发
 * 路由树编译。任何构造期错误都会让 test 立刻失败。
 *
 * 背景：6.2 推送时这类问题逃过了 tsc + service unit tests，因为当时
 * 所有测试都只覆盖 service 层，没有任何 test 会去构造完整的 Elysia app
 * 看它是否能启动。线上 startup 时才报 "Cannot create route ..." 错误。
 */

import { describe, it, expect } from 'bun:test';
import { buildApp } from '#internal/app';

describe('App startup smoke test', () => {
  it('should build Elysia app without route conflicts', async () => {
    // 构造 app —— 任何路由注册期错误会在这里抛
    const app = buildApp();
    expect(app).toBeDefined();

    // 调一次 handle() 强制路由树编译（memoirist 构建 trie）
    // memoirist 的参数命名冲突检测是在路径第一次访问时触发的
    const res = await app.handle(new Request('http://localhost/health'));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});
