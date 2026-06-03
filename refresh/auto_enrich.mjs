#!/usr/bin/env node
// refresh/auto_enrich.mjs
// DAILY auto-enrichment. Finds building pins newly added to the live map, drafts a
// merlon-authenticity verdict for each via OpenRouter (web-grounded), and writes it
// STRAIGHT to Supabase tagged provenance:"ai-draft", approved:false.
// The website badges these as "AI-generated - unverified". A later admin screen flips
// approved:true once a human has checked/edited them.
//
// "New" = on the map but NOT in the ledger (merged_enrichment.json) AND NOT already in
// Supabase. So existing pins (including the 40 undetermined) and yesterday's drafts are skipped.
//
// Anti-hallucination guards (same as the PR drafter): web search is forced; `sources`
// are the pages actually cited; no citations => verdict forced to UNDETERMINED.
//
// Env:
//   OPENROUTER_API_KEY    (required)
//   OPENROUTER_MODEL      (set to your model slug)
//   SUPABASE_URL          (optional; defaults to the project URL)
//   SUPABASE_SERVICE_KEY  (required — service_role; needed to write)

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const LEDGER = join(__dir, '..', 'merged_enrichment.json');
const MID = process.env.MID || '1y1hxOfGDFhqo97deJVvFNi7ASspTlp9v';
const KML_URL = process.env.KML_URL || `https://www.google.com/maps/d/kml?mid=${MID}&forcekml=1`;
const OR_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-latest'; // override with your model slug
const SB_URL = process.env.SUPABASE_URL || 'https://ymaqlcfjmdwncdbjprmw.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!OR_KEY) { console.error('Set OPENROUTER_API_KEY'); process.exit(1); }
if (!SB_KEY) { console.error('Set SUPABASE_SERVICE_KEY (service_role) — needed to write drafts'); process.exit(1); }

const norm = s => (s || '').replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').replace(/\s+/g, ' ').trim();
function parseKml(kml) {
  const out = [];
  for (const chunk of kml.split('<Folder>').slice(1)) {
    const folder = norm((chunk.match(/<name>([\s\S]*?)<\/name>/) || [])[1] || '');
    for (const pm of chunk.split('<Placemark>').slice(1)) {
      const name = norm((pm.match(/<name>([\s\S]*?)<\/name>/) || [])[1] || '');
      const desc = norm((pm.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || '');
      if (name) out.push({ name, folder, desc });
    }
  }
  return out;
}
const isBuilding = f => { const s = f.toLowerCase(); return !s.includes('non-manuscript') && !s.includes('manuscript'); };

const SYSTEM = `You are a cautious architectural-history researcher. Task: decide whether a building's swallowtail (Ghibelline) merlons are original medieval fabric or a later (usually 19th-20th-century) restoration or addition. Use the web search tool to find the building's restoration history from reliable sources (official site, museum, heritage authority, scholarship). Rules: base every claim only on pages you actually retrieved; never invent a date or a source; if you cannot find a reliable statement about the merlons specifically, return verdict "UNDETERMINED" with empty sources. Respond with STRICT JSON only, no prose, exactly: {"verdict":"ORIGINAL_MEDIEVAL|RESTORED_OR_ADDED|CONTESTED|UNDETERMINED","basis":"1-2 plain sentences stating what the sources show","confidence":"low|medium|high","scope":"which part of the structure, e.g. keep / curtain / gate-towers","uncertain":"what you remain unsure about"}`;

async function draft(pin) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OR_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://merlon-lens.vercel.app',
      'X-Title': 'merlon-lens enrichment',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Building: "${pin.name}". Map note: ${pin.desc || '(none)'}. Are its swallowtail merlons original medieval, or a later restoration/addition?` },
      ],
      tools: [{ type: 'openrouter:web_search', parameters: { max_results: 5, max_total_results: 15 } }],
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });
  if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  const msg = data.choices?.[0]?.message || {};
  const citations = (msg.annotations || []).filter(a => a.type === 'url_citation').map(a => a.url_citation?.url).filter(Boolean);
  let web;
  try { web = JSON.parse(msg.content || '{}'); }
  catch { web = { verdict: 'UNDETERMINED', basis: 'AI returned unparseable output.', confidence: 'low', scope: 'whole site', uncertain: 'parse failure' }; }
  const sources = [...new Set(citations)];
  if (!sources.length) {
    web.verdict = 'UNDETERMINED';
    web.basis = `${web.basis || ''} [no web citations returned — treated as not grounded]`.trim();
    web.confidence = 'low';
  }
  web.sources = sources;
  return web;
}

// known = ledger names + everything already in Supabase
const ledger = JSON.parse(await readFile(LEDGER, 'utf8')).records || {};
const sbResp = await fetch(`${SB_URL}/rest/v1/merlon_enrichment?select=pin`, { headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` } });
if (!sbResp.ok) { console.error('Supabase read failed', sbResp.status, (await sbResp.text()).slice(0, 200)); process.exit(1); }
const sbPins = (await sbResp.json()).map(r => norm(r.pin));
const known = new Set([...Object.keys(ledger).map(norm), ...sbPins]);

const kml = await (await fetch(KML_URL)).text();
const pins = parseKml(kml);
const targets = pins.filter(p => !known.has(p.name) && isBuilding(p.folder));
console.log(`Model: ${MODEL} · live pins: ${pins.length} · known: ${known.size} · new buildings: ${targets.length}`);
if (!targets.length) { console.log('Nothing new. Done.'); process.exit(0); }

const rows = [];
for (const p of targets) {
  try {
    const web = await draft(p);
    rows.push({ pin: p.name, type: 'building', payload: { web, corpus: null, agreement: 'WEB_ONLY', provenance: 'ai-draft', approved: false }, updated_at: new Date().toISOString() });
    console.log(`  drafted: ${p.name} -> ${web.verdict} [${web.confidence}] (${web.sources.length} citations)`);
  } catch (e) {
    console.error(`  FAILED ${p.name}: ${e.message}`);
  }
}
if (!rows.length) { console.log('No drafts produced.'); process.exit(0); }

const up = await fetch(`${SB_URL}/rest/v1/merlon_enrichment?on_conflict=pin`, {
  method: 'POST',
  headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' },
  body: JSON.stringify(rows),
});
if (!up.ok) { console.error('Upsert failed', up.status, (await up.text()).slice(0, 200)); process.exit(1); }
console.log(`Wrote ${rows.length} AI drafts to Supabase (provenance:"ai-draft", approved:false) — live, badged "unverified".`);
