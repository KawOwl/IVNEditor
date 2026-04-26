/**
 * 一次性诊断脚本：查 llm_configs 现状 + 翻 thinking 模式开关 + 看最新 playthrough CoreEvents。
 * 运行：bun --env-file=.env scripts/probe-llm-config.mts [enable|disable|show|events]
 */

import { Client } from 'pg';

const url = process.env.DATABASE_URL!;
const cleanedUrl = url.replace(/[?&]sslmode=[^&]*/g, '');
const c = new Client({ connectionString: cleanedUrl, ssl: false });
await c.connect();

const action = process.argv[2] ?? 'show';

if (action === 'enable') {
  const r = await c.query(
    `UPDATE llm_configs SET thinking_enabled=true, reasoning_effort='high', updated_at=NOW()
     WHERE name='deepseek' RETURNING id, name, model, thinking_enabled, reasoning_effort`,
  );
  console.log('enabled thinking on rows:');
  console.log(JSON.stringify(r.rows, null, 2));
} else if (action === 'disable') {
  const r = await c.query(
    `UPDATE llm_configs SET thinking_enabled=NULL, reasoning_effort=NULL, updated_at=NOW()
     WHERE name='deepseek' RETURNING id, name, model, thinking_enabled, reasoning_effort`,
  );
  console.log('reverted to default on rows:');
  console.log(JSON.stringify(r.rows, null, 2));
} else if (action === 'events') {
  // 最新 playthrough 的 core_event_envelopes
  const ptId = process.argv[3];
  if (!ptId) {
    const latest = await c.query(`SELECT id FROM playthroughs ORDER BY created_at DESC LIMIT 1`);
    console.log('latest playthrough:', latest.rows[0]);
  }
  const finalPtId = ptId ?? (await c.query(`SELECT id FROM playthroughs ORDER BY created_at DESC LIMIT 1`)).rows[0].id;
  const r = await c.query(
    `SELECT sequence, occurred_at, event->>'type' AS type, event
     FROM core_event_envelopes
     WHERE playthrough_id = $1
     ORDER BY sequence`,
    [finalPtId],
  );
  console.log(`core_event_envelopes for ${finalPtId}: ${r.rows.length} rows`);
  for (const row of r.rows) {
    console.log(`  ${row.sequence}: ${row.type} at ${row.occurred_at}`);
  }
} else {
  const r = await c.query(
    `SELECT id, name, model, base_url, thinking_enabled, reasoning_effort, max_output_tokens
     FROM llm_configs ORDER BY created_at`,
  );
  console.log('llm_configs:');
  console.log(JSON.stringify(r.rows, null, 2));

  const p = await c.query(`SELECT count(*)::int AS n FROM playthroughs`);
  console.log('playthroughs total:', p.rows[0]);

  const s = await c.query(`SELECT count(*)::int AS n FROM scripts`);
  console.log('scripts total:', s.rows[0]);
}

await c.end();
