// api/enrichment.js — Vercel serverless function.
// Serves the merlon enrichment from the Research-agent Supabase project (table public.merlon_enrichment),
// shaped as { records: { "<pin name>": { type, ...payload } } } so the client can join by pin name.
// Reads via the publishable key against the public-read RLS policy. CORS + 5-min edge cache.

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ymaqlcfjmdwncdbjprmw.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_publishable_9MpT1VOi0nvF-2N1LIS4Ew_h5dQWcp2';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/merlon_enrichment?select=pin,type,payload`, {
      headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!r.ok) { res.status(502).json({ error: `supabase ${r.status}` }); return; }
    const rows = await r.json();
    const records = {};
    for (const row of rows) records[row.pin] = Object.assign({ type: row.type }, row.payload);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({ generator: 'merlon-lens-enrichment', count: rows.length, records });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
