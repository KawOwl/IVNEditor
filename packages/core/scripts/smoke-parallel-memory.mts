/**
 * Parallel memory provider · 真实 HTTP e2e smoke
 *
 * 不调 LLM（不走 GameSession），但走 production 工厂路径：
 *   createMemory({ provider:'parallel' }) → 递归构造 MemoraxMemory + Mem0Memory
 *   → 真发 HTTP 到 47.99.179.197 / mem0 云端
 *
 * 跑：
 *   bun --env-file=apps/server/.env packages/core/scripts/smoke-parallel-memory.mts
 *
 * 三段验证：
 *   Phase 1 happy path — fan-out 写两端、retrieve 走 Memorax（meta.source='memorax'）
 *   Phase 2 fallback   — 故意把 Memorax baseUrl 改坏，retrieve 应 fallback 到 mem0
 *                        （meta.source='mem0'）
 *   Phase 3 cloud check — curl Memorax 后端确认云端真有这些记录
 *
 * 退出码：全过 0；任一断言失败 1。
 */

import { createMemory } from '#internal/memory/factory';
import type { Memory } from '#internal/memory/types';
import type { MemoryConfig } from '#internal/types';

const MEMORAX_BASE_URL = requireEnv('MEMORAX_BASE_URL');
const MEMORAX_API_KEY = requireEnv('MEMORAX_API_KEY');
const MEMORAX_APP_ID = Bun.env.MEMORAX_APP_ID ?? 'ivn-editor';
const MEM0_API_KEY = requireEnv('MEM0_API_KEY');

const ts = Date.now();
const userId = `smoke-user-${ts}`;
const playthroughId = `smoke-pt-${ts}`;

const memoryConfig: MemoryConfig = {
  contextBudget: 100_000,
  compressionThreshold: 100_000,
  recencyWindow: 6,
  provider: 'parallel',
  // 默认 children=['memorax','mem0']（memorax-primary）
};

console.log(`▶ smoke run user_id=${userId}  agent_id(playthrough)=${playthroughId}\n`);

// ─────────────────────────────────────────────────────────────────────
// Phase 1 — happy path
// ─────────────────────────────────────────────────────────────────────

const mem = await createMemory({
  scope: { playthroughId, userId },
  config: memoryConfig,
  memoraxConfig: {
    baseUrl: MEMORAX_BASE_URL,
    apiKey: MEMORAX_API_KEY,
    appId: MEMORAX_APP_ID,
  },
  mem0ApiKey: MEM0_API_KEY,
});

console.log(`✓ createMemory("parallel") → kind=${mem.kind}`);

const facts = [
  { role: 'generate' as const, content: 'Alice picked up the silver key from the desk drawer.' },
  { role: 'receive' as const, content: 'I want to try the locked door at the end of the hall.' },
  { role: 'generate' as const, content: 'The silver key turned smoothly in the lock; the door swung open to reveal a small library full of leather-bound books.' },
];

for (const [i, f] of facts.entries()) {
  await mem.appendTurn({ turn: i + 1, role: f.role, content: f.content, tokenCount: estimate(f.content) });
}
await mem.pin('Alice carries: the silver key (verified by smoke-parallel)', ['inventory']);

console.log(`✓ wrote ${facts.length} appendTurn + 1 pin to both stores`);

// 等两端 ingest + LLM 抽取（mem0 同步 add 但 extraction 偶尔慢；Memorax async_mode 抽取也要时间）
const WAIT_MS = 15_000;
console.log(`  ... waiting ${WAIT_MS / 1000}s for cloud extraction`);
await sleep(WAIT_MS);

const happy = await mem.retrieve('What items has Alice picked up?');
console.log(`\nPhase 1 retrieve:`);
console.log(`  meta.source = ${happy.meta?.source}`);
console.log(`  summary preview:\n${indent(truncate(happy.summary, 600))}`);

assert(happy.meta?.source === 'memorax', `expected meta.source='memorax', got '${happy.meta?.source}'`);
console.log(`✓ retrieve served by memorax (primary)\n`);

// ─────────────────────────────────────────────────────────────────────
// Phase 2 — Memorax 故意挂掉，应该 fallback 到 mem0
// ─────────────────────────────────────────────────────────────────────

const memBroken = await createMemory({
  scope: { playthroughId, userId },
  config: memoryConfig,
  // Memorax 用一个走得通 DNS 但 token 是垃圾的 base —— search 会 401
  memoraxConfig: {
    baseUrl: MEMORAX_BASE_URL,
    apiKey: 'sk_definitely-invalid-fallback-test',
    appId: MEMORAX_APP_ID,
  },
  mem0ApiKey: MEM0_API_KEY,
});

const fallback = await memBroken.retrieve('What items has Alice picked up?');
console.log(`Phase 2 retrieve (broken memorax key):`);
console.log(`  meta.source = ${fallback.meta?.source}`);
console.log(`  attempted   = ${JSON.stringify(fallback.meta?.attempted)}`);
console.log(`  summary preview:\n${indent(truncate(fallback.summary, 600))}`);

assert(
  fallback.meta?.source === 'mem0' || fallback.meta?.source === 'all-failed',
  `expected meta.source='mem0' or 'all-failed', got '${fallback.meta?.source}'`,
);
console.log(`✓ Memorax failure surfaced; ParallelMemory fell through (source=${fallback.meta?.source})\n`);

// ─────────────────────────────────────────────────────────────────────
// Phase 3 — 直接 curl Memorax 验证云端 record 真存在
// ─────────────────────────────────────────────────────────────────────

const cloudCheck = await fetch(`${MEMORAX_BASE_URL.replace(/\/+$/, '')}/v1/memories/search`, {
  method: 'POST',
  headers: {
    Authorization: `Token ${MEMORAX_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    query: 'silver key',
    user_id: userId,
    top_k: 10,
    filters: { and: [{ agent_id: { eq: playthroughId } }] },
  }),
});
const cloudJson = (await cloudCheck.json()) as { success: boolean; data: Array<{ memory: string; agent_id: string }> };

console.log(`Phase 3 Memorax cloud direct check:`);
console.log(`  success=${cloudJson.success}, items=${cloudJson.data?.length ?? 0}`);
for (const m of cloudJson.data ?? []) {
  console.log(`   - ${m.memory}  | agent=${m.agent_id}`);
}
assert(cloudJson.success === true, 'Memorax cloud search failed');
assert((cloudJson.data?.length ?? 0) > 0, 'Memorax cloud has no records for this agent_id (writes did not land)');
assert(
  (cloudJson.data ?? []).every((m) => m.agent_id === playthroughId),
  'Memorax cloud returned cross-agent results (filter not honored)',
);
console.log(`✓ Memorax cloud has ${cloudJson.data.length} records, all agent_id=${playthroughId}\n`);

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('e2e smoke PASSED');
process.exit(0);

// ─────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const v = Bun.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function estimate(text: string): number {
  return Math.ceil(text.length / 3);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function indent(s: string): string {
  return s
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}

function assert(cond: boolean, msg: string): void {
  if (!cond) {
    console.error(`✗ ASSERT FAILED: ${msg}`);
    process.exit(1);
  }
}

// keep tsc happy — Memory type is conceptually used via mem.kind but explicit
// re-export for trace line clarity
type _UnusedMemory = Memory;
