#!/usr/bin/env node
// refresh/gaps.mjs — detect what's drifted out of date.
// Fetches the LIVE map and compares pin names against the enrichment ledger
// (merged_enrichment.json = the record of everything we've already processed).
// Reports:
//   NEW      — pins on the map with no ledger entry yet (these need research)
//   UNRESOLVED — buildings already processed but still "undetermined" (optional revisit)
// Exit code is non-zero when NEW pins exist, so CI can flag it.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const MID = process.env.MID || '1y1hxOfGDFhqo97deJVvFNi7ASspTlp9v';
const KML_URL = process.env.KML_URL || `https://www.google.com/maps/d/kml?mid=${MID}&forcekml=1`;
const LEDGER = process.env.ENRICHMENT_FILE || join(__dir, '..', 'merged_enrichment.json');

const norm = s => (s || '').replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').replace(/\s+/g, ' ').trim();

function parseKml(kml) {
  const out = [];
  for (const chunk of kml.split('<Folder>').slice(1)) {
    const folder = norm((chunk.match(/<name>([\s\S]*?)<\/name>/) || [])[1] || '');
    for (const pm of chunk.split('<Placemark>').slice(1)) {
      const name = norm((pm.match(/<name>([\s\S]*?)<\/name>/) || [])[1] || '');
      if (name) out.push({ name, folder });
    }
  }
  return out;
}

const kml = await (await fetch(KML_URL)).text();
const pins = parseKml(kml);
const ledger = JSON.parse(await readFile(LEDGER, 'utf8')).records || {};
const known = new Set(Object.keys(ledger).map(norm));

const news = pins.filter(p => !known.has(p.name));
const unresolved = Object.entries(ledger)
  .filter(([, r]) => r.type === 'building' && (r.web?.verdict === 'UNDETERMINED') && !r.corpus)
  .map(([n]) => n);

console.log(`Live pins: ${pins.length} · ledger entries: ${known.size}`);
console.log(`\nNEW (on map, not yet processed): ${news.length}`);
for (const p of news) console.log(`  + [${p.folder}] ${p.name}`);
console.log(`\nUNRESOLVED buildings (undetermined, optional revisit): ${unresolved.length}`);

process.exitCode = news.length ? 1 : 0;
