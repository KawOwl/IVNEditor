/**
 * 一次性诊断脚本：查 llm_configs 现状 + 翻 thinking 模式开关 + 看最新 playthrough entries。
 * 运行：bun --env-file=.env scripts/probe-llm-config.mts [enable|disable|show|entries]
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
} else if (action === 'entries') {
  // 最新 playthrough 的 narrative_entries
  const ptId = process.argv[3];
  if (!ptId) {
    const latest = await c.query(`SELECT id FROM playthroughs ORDER BY created_at DESC LIMIT 1`);
    console.log('latest playthrough:', latest.rows[0]);
  }
  const finalPtId = ptId ?? (await c.query(`SELECT id FROM playthroughs ORDER BY created_at DESC LIMIT 1`)).rows[0].id;
  const r = await c.query(
    `SELECT id, kind, batch_id, order_idx, content, reasoning IS NULL AS reasoning_null, length(reasoning) AS reasoning_len, payload
     FROM narrative_entries
     WHERE playthrough_id = $1
     ORDER BY order_idx`,
    [finalPtId],
  );
  console.log(`narrative_entries for ${finalPtId}: ${r.rows.length} rows`);
  for (const row of r.rows) {
    console.log(`  ${row.order_idx}: ${row.kind}, batch=${row.batch_id?.slice(0, 8)}, reasoning_null=${row.reasoning_null}, reasoning_len=${row.reasoning_len}, content="${String(row.content ?? '').slice(0, 60).replace(/\n/g, '\\n')}"`);
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
