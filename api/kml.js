// api/kml.js — Vercel serverless function.
// Proxies Koen Gheuens' live Google "My Maps" KML and re-serves it with CORS,
// so the static page can read the LIVE map (Google's KML endpoint sends no CORS header).
// Response is whatever Google returns (KML text or, occasionally, a KMZ zip — the client handles both).

const DEFAULT_MID = '1y1hxOfGDFhqo97deJVvFNi7ASspTlp9v'; // "Swallowtail Merlons"

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  const mid = (req.query && req.query.mid ? String(req.query.mid) : DEFAULT_MID).trim();
  if (!/^[A-Za-z0-9_-]{10,}$/.test(mid)) { res.status(400).json({ error: 'bad mid' }); return; }

  const url = `https://www.google.com/maps/d/kml?mid=${encodeURIComponent(mid)}&forcekml=1`;
  try {
    const upstream = await fetch(url, { redirect: 'follow' });
    if (!upstream.ok) { res.status(502).json({ error: `upstream ${upstream.status}` }); return; }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/vnd.google-earth.kml+xml; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600'); // 5-min edge cache
    res.status(200).send(buf);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
