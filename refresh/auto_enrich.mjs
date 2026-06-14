#!/usr/bin/env node
// refresh/auto_enrich.mjs  (v2)
// DAILY auto-enrichment for the merlon-lens map.
//
// SCOPE (what it researches each run):
//   • BUILDING pins whose current verdict is UNDETERMINED and not human-approved.
//     (Brand-new buildings count here too — with no record they default to undetermined.)
//   • MANUSCRIPT pins that have no IIIF manifest yet and are not human-approved.
//
// OUTPUT (what it proposes):
//   • buildings   -> a web-grounded merlon-authenticity VERDICT.
//   • manuscripts -> a VERIFIED IIIF manifest (URL must actually resolve as IIIF) plus a
//                    thumbnail IMAGE derived from that manifest.
//
// SAFETY GUARDS:
//   • Approved rows (approved:true) are NEVER touched.
//   • Writes MERGE into the existing payload (read first, spread, then patch) so manual
//     fields — corpus notes, existing images, etc. — are preserved, never clobbered.
//   • Manifests are written only if the candidate URL fetches and parses as valid IIIF.
//     A confidently-wrong-looking URL that doesn't resolve is dropped.
//   • Buildings: if the draft is grounded (has citations) it becomes the verdict; if not,
//     the pin is recorded as "AI-checked, undetermined" so it isn't re-researched daily.
//   • Every AI write is tagged provenance:"ai-draft", approved:false — the site badges
//     these "AI-suggested / unverified" until a human approves them.
//   • Per-run CAPS (MAX_BUILDINGS / MAX_MANUSCRIPTS) bound cost. Targets are processed
//     least-recently-tried first, so the job cycles through the backlog over several days
//     and periodically re-checks stale pins (sources may appear later) instead of
//     re-hammering the same pins every day.
//
// Env: OPENROUTER_API_KEY (req), OPENROUTER_MODEL (set your slug), SUPABASE_URL (opt),
//      SUPABASE_SERVICE_KEY (req — service_role, to write),
//      MAX_BUILDINGS (opt, default 8), MAX_MANUSCRIPTS (opt, default 4),
//      MID / KML_URL (opt — defaults to Koen's map).

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
const MAX_BUILDINGS = parseInt(process.env.MAX_BUILDINGS || '8', 10);
const MAX_MANUSCRIPTS = parseInt(process.env.MAX_MANUSCRIPTS || '4', 10);
if (!OR_KEY) { console.error('Set OPENROUTER_API_KEY'); process.exit(1); }
if (!SB_KEY) { console.error('Set SUPABASE_SERVICE_KEY (service_role) — needed to write'); process.exit(1); }

const norm = s => (s || '').replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').replace(/\s+/g, ' ').trim();
const isManuscript = f => { const s = f.toLowerCase(); return s.includes('manuscript') && !s.includes('non-manuscript'); };
const isArt = f => f.toLowerCase().includes('non-manuscript');
const isBuilding = f => !isManuscript(f) && !isArt(f);

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

// Tolerant JSON: strips markdown fences, falls back to the first {...} block.
function parseLoose(s) {
  if (!s) return null;
  let t = String(s).replace(/```json/gi, '```').replace(/```/g, '').trim();
  try { return JSON.parse(t); } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

// Convert common IIIF viewer URLs to manifest URLs (same heuristics as the client).
function normalizeManifest(u) {
  u = (u || '').trim(); if (!u) return null; let m;
  if ((m = u.match(/gallica\.bnf\.fr\/ark:\/(\d+)\/([a-z0-9]+)/i))) return `https://gallica.bnf.fr/iiif/ark:/${m[1]}/${m[2]}/manifest.json`;
  if ((m = u.match(/digi\.vatlib\.it\/view\/(MSS_[^/?#]+)/i))) return `https://digi.vatlib.it/iiif/${m[1]}/manifest.json`;
  if ((m = u.match(/digital\.bodleian\.ox\.ac\.uk\/objects\/([0-9a-f-]+)/i))) return `https://iiif.bodleian.ox.ac.uk/iiif/manifest/${m[1]}.json`;
  if ((m = u.match(/e-codices\.unifr\.ch\/.*\/([a-z]+-[a-z]+-\d+)/i))) return `https://www.e-codices.unifr.ch/metadata/iiif/${m[1]}/manifest.json`;
  return u; // pass through; verification is the real gate
}

// Fetch a candidate URL and confirm it is real IIIF (v2 sequences or v3 items). Returns a thumbnail if present.
async function verifyManifest(url) {
  if (!url) return { ok: false };
  try {
    const r = await fetch(url, { redirect: 'follow', headers: { accept: 'application/json,application/ld+json,*/*' } });
    if (!r.ok) return { ok: false };
    let j; try { j = JSON.parse(await r.text()); } catch { return { ok: false }; }
    const v2 = Array.isArray(j.sequences), v3 = Array.isArray(j.items);
    const ctx = String(j['@context'] || '').toLowerCase();
    if (!(v2 || v3 || ctx.includes('iiif'))) return { ok: false };
    let thumb = null;
    if (v2) { const res = j.sequences[0]?.canvases?.[0]?.images?.[0]?.resource; thumb = res && (res['@id'] || res.id); }
    else if (v3) { const b = j.items?.[0]?.items?.[0]?.items?.[0]?.body; thumb = b && (b.id || b['@id']); }
    return { ok: true, manifest: url, thumb: thumb || null };
  } catch { return { ok: false }; }
}

// ---- OpenRouter (web-grounded, strict JSON) ----
async function orChat(messages) {
  const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OR_KEY}`, 'Content-Type': 'application/json',
      'HTTP-Referer': 'https://merlon-lens.vercel.app', 'X-Title': 'merlon-lens enrichment',
    },
    body: JSON.stringify({
      model: MODEL, messages,
      tools: [{ type: 'openrouter:web_search', parameters: { max_results: 5, max_total_results: 15 } }],
      temperature: 0, response_format: { type: 'json_object' },
    }),
  });
  if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const msg = (await r.json()).choices?.[0]?.message || {};
  const citations = (msg.annotations || []).filter(a => a.type === 'url_citation').map(a => a.url_citation?.url).filter(Boolean);
  return { content: msg.content || '', citations: [...new Set(citations)] };
}

const VERDICT_SYS = `You are a cautious architectural-history researcher. Decide whether a building's swallowtail (Ghibelline) merlons are original medieval fabric or a later (usually 19th-20th-century) restoration or addition. Use web search to find the building's restoration history from reliable sources (official site, museum, heritage authority, scholarship). Base every claim only on pages you actually retrieved; never invent a date or a source; if you cannot find a reliable statement about the merlons specifically, return verdict "UNDETERMINED" with empty sources. Respond with STRICT JSON only: {"verdict":"ORIGINAL_MEDIEVAL|RESTORED_OR_ADDED|CONTESTED|UNDETERMINED","basis":"1-2 plain sentences on what the sources show","confidence":"low|medium|high","scope":"which part, e.g. keep / curtain / gate-towers","uncertain":"what you remain unsure about"}`;

const MANIFEST_SYS = `You locate the IIIF manifest for a specific medieval manuscript. Use web search on recognised digital libraries (Gallica/BnF, DigiVatLib, Bodleian, e-codices, Biblissima, British Library, Yale/Beinecke, Morgan, KBR, Berlin Staatsbibliothek, national libraries). Return STRICT JSON only: {"manifest_url":"<a direct IIIF manifest.json or info URL you actually saw on a page, else empty>","viewer_url":"<the IIIF viewer page URL if that is all you found, else empty>","library":"<host>","confidence":"low|medium|high","uncertain":"<doubts>"}. Never fabricate a URL; only return URLs from pages you actually retrieved. If unsure, leave both empty.`;

async function draftVerdict(pin) {
  const { content, citations } = await orChat([
    { role: 'system', content: VERDICT_SYS },
    { role: 'user', content: `Building: "${pin.name}". Map note: ${pin.desc || '(none)'}. Are its swallowtail merlons original medieval, or a later restoration/addition?` },
  ]);
  let web = parseLoose(content) || { verdict: 'UNDETERMINED', basis: 'AI returned unparseable output.', confidence: 'low', scope: 'whole site', uncertain: 'parse failure' };
  if (!citations.length) { web.verdict = 'UNDETERMINED'; web.basis = `${web.basis || ''} [no web citations — not grounded]`.trim(); web.confidence = 'low'; }
  web.sources = citations;
  return web;
}

async function findManifest(pin) {
  const { content } = await orChat([
    { role: 'system', content: MANIFEST_SYS },
    { role: 'user', content: `Manuscript: "${pin.name}". Map note: ${pin.desc || '(none)'}. Find its IIIF manifest.` },
  ]);
  const j = parseLoose(content) || {};
  const cands = [j.manifest_url, j.viewer_url].filter(Boolean).map(normalizeManifest).filter(Boolean);
  for (const c of cands) { const v = await verifyManifest(c); if (v.ok) return v; }
  return { ok: false };
}

// ---- gather current state ----
const ledger = JSON.parse(await readFile(LEDGER, 'utf8')).records || {};
const sbResp = await fetch(`${SB_URL}/rest/v1/merlon_enrichment?select=pin,type,payload`, { headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` } });
if (!sbResp.ok) { console.error('Supabase read failed', sbResp.status, (await sbResp.text()).slice(0, 200)); process.exit(1); }
const byPin = new Map((await sbResp.json()).map(r => [norm(r.pin), r]));

const stripType = o => { const { type, lat, lon, ...rest } = o || {}; return rest; };
function curVerdict(n) {
  const r = byPin.get(norm(n));
  if (r) return { v: r.payload?.web?.verdict || 'UNDETERMINED', ap: !!r.payload?.approved, payload: r.payload || {}, lastTry: r.payload?.ai_last_try };
  const l = ledger[n]; if (l) return { v: l.web?.verdict || 'UNDETERMINED', ap: !!l.approved, payload: stripType(l), lastTry: l.ai_last_try };
  return { v: 'UNDETERMINED', ap: false, payload: {}, lastTry: null };
}
function curManifest(n) {
  const r = byPin.get(norm(n));
  if (r) return { m: r.payload?.manifest || null, ap: !!r.payload?.approved, payload: r.payload || {}, lastTry: r.payload?.ai_last_try };
  const l = ledger[n]; if (l) return { m: l.manifest || null, ap: !!l.approved, payload: stripType(l), lastTry: l.ai_last_try };
  return { m: null, ap: false, payload: {}, lastTry: null };
}

const pins = parseKml(await (await fetch(KML_URL)).text());
const bTargets = [], mTargets = [];
for (const p of pins) {
  if (isBuilding(p.folder)) { const c = curVerdict(p.name); if (c.v === 'UNDETERMINED' && !c.ap) bTargets.push({ ...p, base: c.payload, lastTry: c.lastTry }); }
  else if (isManuscript(p.folder)) { const c = curManifest(p.name); if (!c.m && !c.ap) mTargets.push({ ...p, base: c.payload, lastTry: c.lastTry }); }
}
const byTry = (a, b) => (a.lastTry ? Date.parse(a.lastTry) : 0) - (b.lastTry ? Date.parse(b.lastTry) : 0); // never-tried first
bTargets.sort(byTry); mTargets.sort(byTry);
const B = bTargets.slice(0, MAX_BUILDINGS), M = mTargets.slice(0, MAX_MANUSCRIPTS);
console.log(`Model ${MODEL} · live pins ${pins.length}`);
console.log(`Undetermined buildings: ${bTargets.length} (this run ${B.length}) · manuscripts missing manifest: ${mTargets.length} (this run ${M.length})`);
if (!B.length && !M.length) { console.log('Nothing to do. Done.'); process.exit(0); }

const now = () => new Date().toISOString();
const rows = [];

for (const p of B) {
  try {
    const web = await draftVerdict(p);
    const grounded = web.sources.length > 0 && web.verdict !== 'UNDETERMINED';
    const payload = { ...p.base, web, agreement: 'WEB_ONLY', provenance: 'ai-draft', approved: false, ai_last_try: now() };
    rows.push({ pin: p.name, type: 'building', payload, updated_at: now() });
    console.log(`  [building] ${p.name} -> ${web.verdict} [${web.confidence}] (${web.sources.length} cites)${grounded ? '  ✓ upgrade' : '  (still undetermined)'}`);
  } catch (e) { console.error(`  [building] FAILED ${p.name}: ${e.message}`); }
}

for (const p of M) {
  try {
    const v = await findManifest(p);
    let payload;
    if (v.ok) {
      payload = { ...p.base, manifest: v.manifest, manifest_status: 'AI-suggested — unverified', ...(v.thumb ? { image: v.thumb } : {}), provenance: 'ai-draft', approved: false, ai_last_try: now() };
      console.log(`  [manuscript] ${p.name} -> manifest OK${v.thumb ? ' (+thumb)' : ''}: ${v.manifest}`);
    } else {
      payload = { ...p.base, manifest_status: 'AI searched — no resolvable IIIF manifest found yet', ai_last_try: now() };
      console.log(`  [manuscript] ${p.name} -> no resolvable manifest`);
    }
    rows.push({ pin: p.name, type: 'ms', payload, updated_at: now() });
  } catch (e) { console.error(`  [manuscript] FAILED ${p.name}: ${e.message}`); }
}

if (!rows.length) { console.log('Nothing produced.'); process.exit(0); }
// Payloads are already merged in JS above; merge-duplicates replaces the row's columns.
const up = await fetch(`${SB_URL}/rest/v1/merlon_enrichment?on_conflict=pin`, {
  method: 'POST',
  headers: { apikey: SB_KEY, authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' },
  body: JSON.stringify(rows),
});
if (!up.ok) { console.error('Upsert failed', up.status, (await up.text()).slice(0, 200)); process.exit(1); }
console.log(`Wrote ${rows.length} rows to Supabase (provenance:"ai-draft", approved:false) — live, badged "unverified".`);
