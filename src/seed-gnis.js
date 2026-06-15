// src/seed-gnis.js
// Import Colorado summits from USGS GNIS — the official federal geographic-names
// database. PUBLIC DOMAIN (U.S. Government work), purpose-built as a gazetteer,
// no ToS restrictions. This replaces the Peakbagger importer.
//
// Data: pipe-delimited "DomesticNames_Colorado.txt" from The National Map
// Staged Products Directory (Geographic Names folder). We filter to feature
// class "Summit" and tag each by mountain region via bounding box.
//
// Two modes:
//   1) FILE:  download DomesticNames_Colorado.txt yourself, drop it in seeds/,
//             then: node src/seed-gnis.js seeds/DomesticNames_Colorado.txt
//   2) URL:   node src/seed-gnis.js --url=<direct-txt-or-zip-url>
//             (only works where outbound network is allowed)
//
// The pipe-delimited columns (current GNIS DomesticNames schema):
//   feature_id|feature_name|feature_class|state_name|state_numeric|
//   county_name|county_numeric|map_name|date_created|date_edited|
//   bgn_type|bgn_authority|bgn_date|prim_lat_dms|prim_long_dms|
//   prim_lat_dec|prim_long_dec|source_lat_dms|source_long_dms|
//   source_lat_dec|source_long_dec|elev_in_m|elev_in_ft|...
// We read by header name (not position) so schema drift doesn't break us.

import fs from 'fs';
import { db, normalizeRoute } from './db.js';
import { regionForLatLon } from './co-regions.js';

const MIN_ELEV_M = Number(process.env.GNIS_MIN_ELEV_M || 3500); // ~11,500 ft, alpine

function parseLine(headers, line) {
  const cols = line.split('|');
  const row = {};
  headers.forEach((h, i) => { row[h.trim().toLowerCase()] = (cols[i] || '').trim(); });
  return row;
}

function ingest(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return { scanned: 0, inserted: 0 };
  const headers = lines[0].split('|');
  const lower = headers.map(h => h.trim().toLowerCase());

  // Resolve column names defensively across GNIS schema versions.
  const col = (cands) => lower.find(h => cands.includes(h));
  const nameCol = col(['feature_name', 'gaz_name', 'name']);
  const classCol = col(['feature_class', 'class']);
  const latCol = col(['prim_lat_dec', 'lat', 'latitude']);
  const lonCol = col(['prim_long_dec', 'lon', 'long', 'longitude']);
  const elevMCol = col(['elev_in_m', 'elevation_m']);
  const elevFtCol = col(['elev_in_ft', 'elevation_ft']);

  // Newer GNIS DomesticNames files DROPPED elevation columns. If elevation is
  // absent, we can't filter by height — instead we keep summits that fall inside
  // a known Colorado mountain-range bounding box (alpine by location).
  const hasElev = Boolean(elevMCol || elevFtCol);
  if (!hasElev) {
    console.log('No elevation column in this GNIS file — filtering summits by mountain-region bounding box instead.');
  }

  const exists = db.prepare(`SELECT id FROM peaks WHERE LOWER(name) = ?`);
  const insert = db.prepare(`
    INSERT INTO peaks (name, lat, lon, elevation_m, prominence_m, region, source, created_at)
    VALUES (@name, @lat, @lon, @elevation_m, @prominence_m, @region, @source, @created_at)
  `);

  let scanned = 0, inserted = 0;
  const tx = db.transaction(() => {
    for (let i = 1; i < lines.length; i++) {
      const row = parseLine(headers, lines[i]);
      scanned++;
      if ((row[classCol] || '').toLowerCase() !== 'summit') continue;
      const name = row[nameCol];
      if (!name) continue;
      const lat = parseFloat(row[latCol]);
      const lon = parseFloat(row[lonCol]);

      let elevM = elevMCol ? parseFloat(row[elevMCol]) : NaN;
      if (isNaN(elevM) && elevFtCol) {
        const ft = parseFloat(row[elevFtCol]);
        if (!isNaN(ft)) elevM = ft * 0.3048;
      }

      const region = (!isNaN(lat) && !isNaN(lon)) ? regionForLatLon(lat, lon) : null;

      // Keep logic:
      //  - if we have elevation: alpine cutoff (>= MIN_ELEV_M)
      //  - if no elevation: keep only summits inside a known mountain region bbox
      if (hasElev) {
        if (isNaN(elevM) || elevM < MIN_ELEV_M) continue;
      } else {
        if (!region) continue; // outside all mountain ranges -> skip (drops plains/urban summits)
      }

      if (exists.get(normalizeRoute(name))) continue;

      insert.run({
        name,
        lat: isNaN(lat) ? null : lat,
        lon: isNaN(lon) ? null : lon,
        elevation_m: isNaN(elevM) ? null : Math.round(elevM),
        prominence_m: null,
        region,
        source: 'gnis',
        created_at: Date.now(),
      });
      inserted++;
    }
  });
  tx();
  return { scanned, inserted };
}

export async function seedGnis({ file = null, url = null } = {}) {
  let text;
  if (file) {
    if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
    text = fs.readFileSync(file, 'utf8');
  } else if (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    text = await res.text();
  } else {
    throw new Error('Provide a file path or --url=');
  }
  const result = ingest(text);
  console.log(`GNIS seed complete: scanned ${result.scanned}, inserted ${result.inserted} summits (>= ${MIN_ELEV_M}m).`);
  return result;
}

if (process.argv[1] && process.argv[1].endsWith('seed-gnis.js')) {
  const urlArg = process.argv.find(a => a.startsWith('--url='));
  const fileArg = process.argv.find(a => !a.startsWith('--') && a.endsWith('.txt'));
  if (!urlArg && !fileArg) {
    console.error('Usage: node src/seed-gnis.js seeds/DomesticNames_Colorado.txt');
    console.error('   or: node src/seed-gnis.js --url=<direct-txt-url>');
    process.exit(1);
  }
  seedGnis({ file: fileArg || null, url: urlArg ? urlArg.split('=')[1] : null })
    .then(r => { console.log(r); process.exit(0); })
    .catch(e => { console.error('Seed failed:', e.message); process.exit(1); });
}
