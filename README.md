# merlon-lens

A **read-only lens** over Koen Gheuens' Google “My Maps” *Swallowtail Merlons* map. It does not fork or replace his map — he keeps editing in Google — it tracks his **live pins** and adds two things Google Maps can't:

1. **IIIF manuscript viewing** for the manuscript-depiction pins.
2. A **sourced merlon-authenticity verdict** per building (is the swallowtail crenellation original medieval, a 19th–20th-c. restoration, contested, or undetermined?), merged from a web cross-reference and the Voynich research corpus.

## How it works

```
Koen edits My Map ──► Google KML endpoint (no CORS)
                              │
                    api/kml.js  (Vercel proxy, +CORS, 5-min edge cache)
                              │                         api/enrichment.js ──► Supabase public.merlon_enrichment
                              └───────────────┬───────────────────┘
                                              ▼
                              public/index.html  (static, read-only)
                                · join pins ⇄ enrichment by pin NAME
                                · manuscript pins → IIIF (OpenSeadragon)
                                · building pins   → colour-coded verdict (web ⊕ corpus)
```

- **Pins** are live from Koen's map via `api/kml.js` (Google's KML export sends no CORS header, so the proxy is required). Map id baked in: `1y1hxOfGDFhqo97deJVvFNi7ASspTlp9v`.
- **Enrichment** is served from Supabase by `api/enrichment.js` (table `public.merlon_enrichment`, public-read RLS).
- The browser **never calls the Voynich MCP** — that is an authenticated *research* endpoint. The MCP is the *build-time* source of the corpus verdicts; `refresh/refresh.mjs` is the loader (below).

## Deploy (Vercel)

1. Create the repo (see the GitHub note) and push these files.
2. Import into Vercel (or `vercel` from the repo root). No build step — it's static + serverless functions.
3. Set env vars (optional — sensible defaults are baked into the functions):
   - `SUPABASE_URL` = `https://ymaqlcfjmdwncdbjprmw.supabase.co`
   - `SUPABASE_KEY` = `sb_publishable_9MpT1VOi0nvF-2N1LIS4Ew_h5dQWcp2`  *(publishable key — safe to expose; read-only under RLS)*
4. Open the deployment. The client fetches `/api/kml` + `/api/enrichment` same-origin. Send Koen the one URL.
   - Optional: `?mid=<other_public_map_id>` points the lens at a different My Map.

## Refresh the enrichment (offline)

The verdicts/manifests in Supabase are produced by research (querying the corpus + web), assembled into `merged_enrichment.json`. To (re)load that into Supabase:

```bash
SUPABASE_URL=https://ymaqlcfjmdwncdbjprmw.supabase.co \
SUPABASE_SERVICE_KEY=<service_role key from Supabase dashboard> \
node refresh/refresh.mjs
```

- Needs the **service_role** key (writes are blocked for the publishable key by RLS). Get it from Supabase → Project Settings → API. Keep it out of the repo (`.env` is gitignored).
- Idempotent (upsert on pin). Stores only the *informative* rows; absent buildings render as “undetermined”.

## Files

```
api/kml.js            live-KML CORS proxy
api/enrichment.js     serves Supabase enrichment as {records:{pin:{type,...}}}
public/index.html     read-only client (Leaflet + OpenSeadragon + fflate)
refresh/refresh.mjs   offline loader: merged_enrichment.json → Supabase upsert
merged_enrichment.json canonical assembled enrichment (loader input + reference)
vercel.json package.json .gitignore
```

## Data model (`merlon_enrichment`)

`pin text PK · type text (ms|building) · payload jsonb · updated_at`

- `ms` → `{ manifest, manifest_status }`
- `building` → `{ web:{verdict,basis,sources,confidence,scope}, corpus:{verdict,source}|null, agreement }`
- verdicts: `ORIGINAL_MEDIEVAL · RESTORED_OR_ADDED · CONTESTED · UNDETERMINED`
- agreement: `AGREE · CORPUS_EXTENDS · CORPUS_CORROBORATES · CORPUS_MENTION_ONLY · WEB_ONLY`

## Caveats

- The pin⇄enrichment **join is by name**. If Koen renames/adds a pin, it shows as plain/undetermined (safe failure, never a wrong verdict). Duplicate pin names collapse to one record (handle in the refresh step — e.g. Vignola, where a building and a fresco share a name, is forced to the building verdict).
- **“Live” = within the 5-min edge cache**, and depends on Google's undocumented KML endpoint.
- Enrichment reflects the last refresh. Re-run `refresh.mjs` after updating `merged_enrichment.json`.
- Where building authenticity is documented it is overwhelmingly a 19th–20th-c. reconstruction; the standing buildings are weaker evidence for medieval merlon form than the manuscript depictions.

## GitHub note

This repo was prepared as a file bundle. Create a new empty repo named **merlon-lens** on GitHub, then from this folder:

```bash
git init && git add . && git commit -m "merlon-lens: live KML + IIIF + merlon-authenticity lens"
git branch -M main
git remote add origin git@github.com:<you>/merlon-lens.git
git push -u origin main
```
