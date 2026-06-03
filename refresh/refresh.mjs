#!/usr/bin/env node
// refresh/refresh.mjs — offline enrichment refresh.
//
// Pipeline role: the RESEARCH step (querying the Voynich MCP corpus + web for each pin and
// writing verdicts) updates ../merged_enrichment.json. THIS script then loads the informative
// rows of that file into Supabase (public.merlon_enrichment) so the live site serves them.
// It does NOT call the MCP at runtime — the MCP is the build-time source, this is the loader.
//
// Requires a SERVICE-ROLE key (writes are blocked for the public/anon key by RLS):
//   SUPABASE_URL=https://ymaqlcfjmdwncdbjprmw.supabase.co \
//   SUPABASE_SERVICE_KEY=<service_role key from Supabase dashboard> \
//   node refresh/refresh.mjs
//
// Idempotent: upserts on the pin primary key.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.ENRICHMENT_FILE || join(__dir, '..', 'merged_enrichment.json');
const URL = process.env.SUPABASE_URL || 'https://ymaqlcfjmdwncdbjprmw.supabase.co';
const KEY = process.env.SUPABASE_SERVICE_KEY;

if (!KEY) {
  console.error('Set SUPABASE_SERVICE_KEY (service_role) — the publishable/anon key cannot write under RLS.');
  process.exit(1);
}

const UNDET = 'UNDETERMINED';

function toRows(records) {
  const rows = [];
  for (const [pin, rec] of Object.entries(records)) {
    if (rec.type === 'ms') {
      rows.push({ pin, type: 'ms', payload: { manifest: rec.manifest ?? null, manifest_status: rec.manifest_status ?? null } });
    } else if (rec.type === 'building') {
      const web = rec.web || {};
      const corpus = rec.corpus ?? null;
      // store only informative rows; the client defaults absent buildings to UNDETERMINED
      if (web.verdict === UNDET && corpus === null) continue;
      rows.push({ pin, type: 'building', payload: { web, corpus, agreement: rec.agreement ?? 'WEB_ONLY' } });
    }
    // art / other: not enriched
  }
  return rows;
}

const data = JSON.parse(await readFile(SRC, 'utf8'));
const rows = toRows(data.records || data);
console.log(`Loaded ${Object.keys(data.records || data).length} pins -> ${rows.length} informative rows from ${SRC}`);

// upsert in one POST (merge-duplicates on the pin PK)
const resp = await fetch(`${URL}/rest/v1/merlon_enrichment?on_conflict=pin`, {
  method: 'POST',
  headers: {
    apikey: KEY,
    authorization: `Bearer ${KEY}`,
    'content-type': 'application/json',
    prefer: 'resolution=merge-duplicates,return=minimal',
  },
  body: JSON.stringify(rows.map(r => ({ ...r, updated_at: new Date().toISOString() }))),
});

if (!resp.ok) {
  console.error('Upsert failed:', resp.status, await resp.text());
  process.exit(1);
}
const byType = rows.reduce((a, r) => ((a[r.type] = (a[r.type] || 0) + 1), a), {});
console.log('Upsert OK:', JSON.stringify(byType));
