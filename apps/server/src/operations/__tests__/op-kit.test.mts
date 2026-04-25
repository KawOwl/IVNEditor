/**
 * op-kit 单元测试 —— 形状契约 + 防腐 lint
 *
 * 重点覆盖：
 *  - defineOp 名字 / category 校验
 *  - runOp input parse → auth check → exec → output parse 的完整链路
 *  - OpError 透传，未类型化错误被裹成 INTERNAL
 */

import { describe, it, expect } from 'bun:test';
import { z } from 'zod/v4';

import { defineOp, runOp, checkAuth, indexOps } from '#internal/operations/op-kit';
import { anonymousOpContext, identityToOpContext } from '#internal/operations/context';
import { OpError, opErrorToHttpStatus } from '#internal/operations/errors';

const adminCtx = identityToOpContext(
  { kind: 'admin', userId: 'u1', username: 'alice', displayName: 'Alice' },
  'http',
  'req-1',
);
const regCtx = identityToOpContext(
  { kind: 'registered', userId: 'u2', username: 'bob', displayName: 'Bob' },
  'http',
  'req-2',
);
const anonCtx = identityToOpContext(
  { kind: 'anonymous', userId: 'u3', username: null, displayName: null },
  'http',
  'req-3',
);
const noneCtx = anonymousOpContext('http', 'req-4');

const sampleOp = defineOp({
  name: 'demo.echo',
  description: 'echo input back',
  category: 'demo',
  effect: 'safe',
  auth: 'admin',
  input: z.object({ value: z.string() }),
  output: z.object({ echoed: z.string() }),
  async exec(input) {
    return { echoed: input.value };
  },
});

describe('defineOp', () => {
  it('rejects op name without dot', () => {
    expect(() =>
      defineOp({
        name: 'no_dot',
        description: 'x',
        category: 'demo',
        effect: 'safe',
        auth: 'admin',
        input: z.object({}),
        output: z.object({}),
        async exec() {
          return {};
        },
      }),
    ).toThrow(/Invalid op name/);
  });

  it('rejects category mismatch', () => {
    expect(() =>
      defineOp({
        name: 'demo.x',
        description: 'x',
        category: 'wrong',
        effect: 'safe',
        auth: 'admin',
        input: z.object({}),
        output: z.object({}),
        async exec() {
          return {};
        },
      }),
    ).toThrow(/category.*mismatch/);
  });

  it('accepts valid op shape', () => {
    expect(sampleOp.name).toBe('demo.echo');
    expect(sampleOp.effect).toBe('safe');
  });
});

describe('checkAuth', () => {
  it("auth='admin' lets admin through, blocks others", () => {
    expect(() => checkAuth(sampleOp, adminCtx)).not.toThrow();
    expect(() => checkAuth(sampleOp, regCtx)).toThrow(OpError);
    expect(() => checkAuth(sampleOp, anonCtx)).toThrow(OpError);
    expect(() => checkAuth(sampleOp, noneCtx)).toThrow(OpError);
  });

  it("auth='registered' blocks anonymous and unauth", () => {
    const op = { ...sampleOp, auth: 'registered' as const };
    expect(() => checkAuth(op, adminCtx)).not.toThrow();
    expect(() => checkAuth(op, regCtx)).not.toThrow();
    expect(() => checkAuth(op, anonCtx)).toThrow(/registered identity required/);
    expect(() => checkAuth(op, noneCtx)).toThrow(/authentication required/);
  });

  it("auth='any' allows anonymous, blocks unauth", () => {
    const op = { ...sampleOp, auth: 'any' as const };
    expect(() => checkAuth(op, anonCtx)).not.toThrow();
    expect(() => checkAuth(op, noneCtx)).toThrow();
  });

  it("auth='none' lets anyone through", () => {
    const op = { ...sampleOp, auth: 'none' as const };
    expect(() => checkAuth(op, noneCtx)).not.toThrow();
    expect(() => checkAuth(op, anonCtx)).not.toThrow();
  });
});

describe('runOp', () => {
  it('parses input, runs exec, parses output', async () => {
    const result = await runOp(sampleOp, { value: 'hi' }, adminCtx);
    expect(result).toEqual({ echoed: 'hi' });
  });

  it('throws INVALID_INPUT on bad input', async () => {
    await expect(runOp(sampleOp, { value: 123 }, adminCtx)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('throws UNAUTHORIZED before parsing input (auth-first)', async () => {
    await expect(runOp(sampleOp, { value: 'x' }, anonCtx)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    // 即使 input 也是错的，应该先报 auth
    await expect(runOp(sampleOp, { wrong: 'shape' }, anonCtx)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('throws INTERNAL on output schema mismatch (op bug)', async () => {
    const buggy = defineOp({
      name: 'demo.bug',
      description: 'returns wrong shape',
      category: 'demo',
      effect: 'safe',
      auth: 'admin',
      input: z.object({}),
      output: z.object({ x: z.string() }),
      // 模拟 op bug：runtime 返回错误 shape，但用 cast 让 TS 通过——
      // 这正是 op-kit output 校验要兜住的场景
      async exec() {
        return { x: 123 } as unknown as { x: string };
      },
    });
    await expect(runOp(buggy, {}, adminCtx)).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });

  it('rethrows OpError from exec verbatim', async () => {
    const errOp = defineOp({
      name: 'demo.notfound',
      description: 'always 404',
      category: 'demo',
      effect: 'safe',
      auth: 'admin',
      input: z.object({}),
      output: z.object({}),
      async exec() {
        throw new OpError('NOT_FOUND', 'fish not found');
      },
    });
    await expect(runOp(errOp, {}, adminCtx)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'fish not found',
    });
  });

  it('does NOT swallow plain Error from exec', async () => {
    const errOp = defineOp({
      name: 'demo.boom',
      description: 'plain error',
      category: 'demo',
      effect: 'safe',
      auth: 'admin',
      input: z.object({}),
      output: z.object({}),
      async exec() {
        throw new Error('boom');
      },
    });
    // Plain Error 不被 op-kit 包装；adapter 看见后才包成 INTERNAL。
    // 这里只验证 op-kit 自身没吞错。
    await expect(runOp(errOp, {}, adminCtx)).rejects.toThrow('boom');
  });
});

describe('indexOps', () => {
  it('builds name → op map', () => {
    const m = indexOps([sampleOp]);
    expect(m.get('demo.echo')).toBe(sampleOp);
  });

  it('rejects duplicate names', () => {
    const dup = defineOp({
      name: 'demo.echo',
      description: 'dup',
      category: 'demo',
      effect: 'safe',
      auth: 'admin',
      input: z.object({}),
      output: z.object({}),
      async exec() {
        return {};
      },
    });
    expect(() => indexOps([sampleOp, dup])).toThrow(/Duplicate op name/);
  });
});

describe('opErrorToHttpStatus', () => {
  it.each([
    ['INVALID_INPUT', 400],
    ['UNAUTHORIZED', 401],
    ['FORBIDDEN', 403],
    ['NOT_FOUND', 404],
    ['CONFLICT', 409],
    ['CONFIRMATION_REQUIRED', 428],
    ['UPSTREAM_UNAVAILABLE', 502],
    ['INTERNAL', 500],
  ] as const)('maps %s → %d', (code, status) => {
    expect(opErrorToHttpStatus(new OpError(code, 'msg'))).toBe(status);
  });

  it('honors details.httpStatus override', () => {
    const e = new OpError('CONFLICT', 'msg', { details: { httpStatus: 412 } });
    expect(opErrorToHttpStatus(e)).toBe(412);
  });
});
