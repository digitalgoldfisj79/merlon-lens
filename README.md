# merlon-lens

A **read-only lens** over Koen Gheuens' Google "My Maps" *Swallowtail Merlons* map. It tracks his live pins and adds two things Google Maps can't: **IIIF manuscript viewing** and a **sourced merlon-authenticity verdict** per building (original medieval / restored / contested / undetermined), merged from a web cross-reference and the Voynich research corpus.

**Live:** https://merlon-lens.vercel.app

---

## ⚠️ Read this before pushing

The repo has two layers:

- **The live site** — needed to run the lens. Safe to deploy as-is, no secrets:
  `api/`, `public/index.html`, `merged_enrichment.json`, `vercel.json`, `package.json`, `.gitignore`
- **Optional automation** — only for auto-handling new pins. **These run on a schedule and will FAIL nightly (emailing you) if their secrets aren't set:**
  `refresh/`, `.github/workflows/`

If you just want the working map, deploy the live-site files and **leave the `.github/workflows/` folder out** until you've added the secrets below.

---

## How it works

```
Koen edits My Map ─► Google KML (no CORS) ─► api/kml.js (Vercel proxy, +CORS, 5-min cache)
                                                      │         api/enrichment.js ─► Supabase (table merlon_enrichment)
                                                      └──────────────┬───────────────┘
                                                                     ▼
                                                       public/index.html (read-only)
                                                         · manuscript pin → IIIF viewer, or hosted PDF
                                                         · building pin   → colour-coded verdict (web ⊕ corpus)
```

The browser never calls the research corpus directly. Enrichment lives in Supabase; the page reads it.

## Deploy (Vercel)

1. Push the repo (or just the live-site files) and import into Vercel — no build step.
2. Defaults are baked in, so no env vars are required for the site to work. (Optional: `SUPABASE_URL`, `SUPABASE_KEY` — the publishable key, safe to expose.)
3. Open the deployment URL. Send Koen the one link; his workflow is unchanged.

## Manuscripts: IIIF and PDFs

- 13 manuscripts resolve to a live **IIIF manifest** (opens in the in-page viewer).
- The 14 without public IIIF can show a **hosted PDF** instead:
  1. Upload the PDF in Supabase → **Storage** → bucket **`manuscripts`** (public, PDF-only, 100 MB/file).
  2. Copy its public URL, then attach it to the manuscript's row:
     ```sql
     update public.merlon_enrichment
     set payload = payload || jsonb_build_object('pdf','PASTE_PUBLIC_URL'),
         updated_at = now()
     where pin = 'EXACT MANUSCRIPT NAME';
     ```
  3. That pin then shows a "📄 Open PDF" button. Only host scans you have the right to (your own / public-domain).

## Keeping it current as Koen adds pins

- **Pins are automatic** — the page reads the live map each load; new pins appear within ~5 min. New buildings show grey "undetermined" until enriched.
- **`refresh/gaps.mjs`** — run locally to list pins on the map that aren't in the ledger yet, plus still-undetermined buildings.
- **`.github/workflows/daily-enrich.yml`** — daily: detects new building pins, drafts a verdict via OpenRouter (web-grounded), writes it to Supabase tagged `provenance:"ai-draft"`, `approved:false`. The page badges these "⚠ AI-generated — unverified" (dashed marker).
- **`.github/workflows/load-enrichment.yml`** — when `merged_enrichment.json` changes on `main`, upserts it to Supabase via `refresh/refresh.mjs`.

### Secrets/variables the automation needs (repo → Settings)
- secret `OPENROUTER_API_KEY` — your OpenRouter key
- secret `SUPABASE_SERVICE_KEY` — Supabase `service_role` key (writes; bypasses RLS)
- var `OPENROUTER_MODEL` — your model slug (Variables tab)
- secret `SUPABASE_URL` — optional (defaults to the project URL)

Also enable: repo → Settings → Actions → General → "Allow GitHub Actions to create and approve pull requests" (only if you re-introduce a PR-based flow).

## Supabase notes

- Project: `ymaqlcfjmdwncdbjprmw` (shared with the Voynich corpus). Table `public.merlon_enrichment` (`pin` PK, `type`, `payload` jsonb, `updated_at`), RLS on, public-read.
- The public-read policy needs the grant too (this project revoked default grants):
  ```sql
  grant select on public.merlon_enrichment to anon, authenticated;
  ```
- `payload` for a building: `{ web:{verdict,basis,sources,confidence,scope}, corpus:{...}|null, agreement, provenance?, approved? }`; for a manuscript: `{ manifest, manifest_status, pdf? }`.

## Files

```
api/kml.js              live-KML CORS proxy
api/enrichment.js       serves Supabase enrichment as {records:{pin:{type,...}}}
public/index.html       read-only client (Leaflet + OpenSeadragon + fflate; IIIF, PDF, verdicts)
merged_enrichment.json  canonical assembled enrichment (loader input + reference)
refresh/refresh.mjs     load the ledger into Supabase (service key)
refresh/gaps.mjs        detect new / unresolved pins on the live map
refresh/auto_enrich.mjs daily AI drafter -> Supabase (OpenRouter + service key)
.github/workflows/daily-enrich.yml    daily detect + draft + write
.github/workflows/load-enrichment.yml load ledger on change
vercel.json package.json .gitignore
```

## Honest caveats

- The pin⇄enrichment join is **by name**; renames de-link until refreshed. Duplicate names collapse to one record (e.g. Vignola is forced to the building verdict).
- "Live" = within the 5-min cache; depends on Google's undocumented KML endpoint.
- AI-drafted verdicts are published **labelled but unreviewed** until an admin pass exists; treat them as leads, not findings.
- The ledger (`merged_enrichment.json`) and Supabase can diverge — AI drafts and PDF links are written to Supabase only. Re-running `refresh.mjs` loads the ledger and won't clobber them, but the durable record stays incomplete unless you also record them in the ledger.
