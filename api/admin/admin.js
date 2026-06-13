// api/admin.js — password-gated write/upload proxy for the merlon-lens admin page.
// The browser never sees a Supabase key. This function holds the service key and a
// shared password (both as env vars) and is the ONLY writer to merlon_enrichment + Storage.
//
// Env (set in Vercel → Project → Settings → Environment Variables):
//   ADMIN_PASSWORD         the shared admin password (required)
//   SUPABASE_SERVICE_KEY   service_role key, same project as the corpus (required)
//   SUPABASE_URL           optional; defaults to the project URL
//
// Actions (POST JSON { password, action, ... }):
//   auth                         -> {ok:true}                     (check the password)
//   patch  {pin, set?, unset?, type?} -> merge/remove payload keys (create row if absent)
//   delete {pin}                 -> remove the pin's row
//   signed-upload {pin, filename, contentType} -> {uploadUrl, publicUrl}  (browser PUTs the file to uploadUrl)

const SB_URL = process.env.SUPABASE_URL || 'https://ymaqlcfjmdwncdbjprmw.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const PW = process.env.ADMIN_PASSWORD;
const BUCKET = 'manuscripts';
const ALLOWED = ['application/pdf', 'image/webp', 'image/jpeg', 'image/png'];

const sbHeaders = (extra) => Object.assign({ apikey: SB_KEY, authorization: `Bearer ${SB_KEY}` }, extra || {});
// PostgREST filter, double-quoted so spaces/commas/dots in pin names are safe
const pinFilter = (pin) => `pin=eq.${encodeURIComponent('"' + pin + '"')}`;
const slug = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return await new Promise((resolve) => {
    let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } });
  });
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!SB_KEY || !PW) return res.status(500).json({ error: 'Server not configured: set SUPABASE_SERVICE_KEY and ADMIN_PASSWORD in Vercel.' });

  const body = await readBody(req);
  if (typeof body.password !== 'string' || body.password !== PW) return res.status(401).json({ error: 'Bad password' });

  const action = body.action;
  try {
    if (action === 'auth') return res.status(200).json({ ok: true });

    if (action === 'patch') {
      const pin = body.pin; if (!pin) throw new Error('pin required');
      const set = body.set && typeof body.set === 'object' ? body.set : {};
      const unset = Array.isArray(body.unset) ? body.unset : [];
      const r = await fetch(`${SB_URL}/rest/v1/merlon_enrichment?${pinFilter(pin)}&select=payload,type`, { headers: sbHeaders() });
      const rows = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(rows));
      if (Array.isArray(rows) && rows.length) {
        const payload = Object.assign({}, rows[0].payload || {}, set);
        for (const k of unset) delete payload[k];
        const u = await fetch(`${SB_URL}/rest/v1/merlon_enrichment?${pinFilter(pin)}`, {
          method: 'PATCH', headers: sbHeaders({ 'content-type': 'application/json', prefer: 'return=representation' }),
          body: JSON.stringify({ payload, updated_at: new Date().toISOString() }),
        });
        const out = await u.json(); if (!u.ok) throw new Error(JSON.stringify(out));
        return res.status(200).json({ ok: true, row: out[0] });
      }
      const payload = Object.assign({}, set); for (const k of unset) delete payload[k];
      const i = await fetch(`${SB_URL}/rest/v1/merlon_enrichment`, {
        method: 'POST', headers: sbHeaders({ 'content-type': 'application/json', prefer: 'return=representation' }),
        body: JSON.stringify({ pin, type: body.type || 'building', payload, updated_at: new Date().toISOString() }),
      });
      const out = await i.json(); if (!i.ok) throw new Error(JSON.stringify(out));
      return res.status(200).json({ ok: true, row: out[0], created: true });
    }

    if (action === 'delete') {
      const pin = body.pin; if (!pin) throw new Error('pin required');
      const d = await fetch(`${SB_URL}/rest/v1/merlon_enrichment?${pinFilter(pin)}`, { method: 'DELETE', headers: sbHeaders({ prefer: 'return=minimal' }) });
      if (!d.ok) throw new Error(await d.text());
      return res.status(200).json({ ok: true, deleted: pin });
    }

    if (action === 'signed-upload') {
      const pin = body.pin || 'misc';
      const filename = (body.filename || 'file').toString();
      const contentType = (body.contentType || '').toString();
      if (!ALLOWED.includes(contentType)) throw new Error('content type not allowed: ' + (contentType || '(none)'));
      const ext = (filename.match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
      const base = slug(filename.replace(/\.[a-z0-9]+$/i, '')) || 'file';
      const path = `${slug(pin)}/${base}${ext}`;
      const s = await fetch(`${SB_URL}/storage/v1/object/upload/sign/${BUCKET}/${encPath(path)}`, { method: 'POST', headers: sbHeaders({ 'content-type': 'application/json' }) });
      const sj = await s.json(); if (!s.ok) throw new Error(JSON.stringify(sj));
      const signed = sj.url || sj.signedURL || sj.signedUrl || '';
      let uploadUrl;
      if (/^https?:\/\//.test(signed)) uploadUrl = signed;
      else if (signed.startsWith('/storage/v1')) uploadUrl = SB_URL + signed;
      else uploadUrl = SB_URL + '/storage/v1' + (signed.startsWith('/') ? '' : '/') + signed;
      const publicUrl = `${SB_URL}/storage/v1/object/public/${BUCKET}/${encPath(path)}`;
      return res.status(200).json({ ok: true, uploadUrl, publicUrl, path, contentType });
    }

    return res.status(400).json({ error: 'unknown action: ' + action });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
}
