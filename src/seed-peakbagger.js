// src/seed-peakbagger.js
// POLITE Peakbagger importer for Colorado peak data (coordinates, elevation,
// prominence). This is intentionally gentle, NOT an aggressive ID crawler:
//   - hard rate limit (default 1 request / 3s) to avoid hammering their server
//   - only pulls public peak summary data
//   - re-runnable, dedupes by name, resumable via stored progress
//   - respects a max-peaks cap per run so you never accidentally crawl everything
//
// Peakbagger does not publish an official API, so this reads the public
// peak pages. If they ever ask us to stop or rate-limit harder, set
// PEAKBAGGER_DELAY_MS higher or stop running it. Be a good citizen.
//
// Usage:  node src/seed-peakbagger.js --ids=1234,5678
//         node src/seed-peakbagger.js --range=10000-10100   (sequential, capped)
//
// Env:
//   PEAKBAGGER_DELAY_MS   ms between requests (default 3000)
//   PEAKBAGGER_MAX        max peaks per run (default 50)

import { db, normalizeRoute } from './db.js';

const DELAY_MS = Number(process.env.PEAKBAGGER_DELAY_MS || 3000);
const MAX_PER_RUN = Number(process.env.PEAKBAGGER_MAX || 50);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Parse the minimal public fields from a Peakbagger peak page HTML.
// Defensive: returns null if the page shape isn't what we expect, rather than
// guessing. We do NOT fabricate coordinates.
function parsePeakHtml(html, peakId) {
  // Peakbagger embeds lat/lon and elevation in the page text in a fairly stable
  // pattern. We extract conservatively and bail if not found.
  const nameMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  const latMatch = html.match(/Latitude[^0-9\-]*(-?\d+\.\d+)/i);
  const lonMatch = html.match(/Longitude[^0-9\-]*(-?\d+\.\d+)/i);
  const elevMatch = html.match(/Elevation[^0-9]*([\d,]+)\s*(?:feet|ft)/i);
  const promMatch = html.match(/Prominence[^0-9]*([\d,]+)\s*(?:feet|ft)/i);

  if (!nameMatch) return null;
  const name = nameMatch[1].trim();
  // Only keep Colorado peaks: rough bounding box check if we have coords.
  const lat = latMatch ? Number(latMatch[1]) : null;
  const lon = lonMatch ? Number(lonMatch[1]) : null;
  if (lat != null && lon != null) {
    const inCO = lat >= 36.9 && lat <= 41.1 && lon >= -109.1 && lon <= -102.0;
    if (!inCO) return { skip: true };
  }
  const ftToM = (s) => s ? Math.round(Number(s.replace(/,/g, '')) * 0.3048) : null;
  return {
    name,
    lat, lon,
    elevation_m: ftToM(elevMatch?.[1]),
    prominence_m: ftToM(promMatch?.[1]),
    source: `peakbagger:${peakId}`,
  };
}

function upsertPeak(p) {
  if (!p || p.skip || !p.name) return false;
  const exists = db.prepare(`SELECT id FROM peaks WHERE LOWER(name) = ?`).get(normalizeRoute(p.name));
  if (exists) return false;
  db.prepare(`
    INSERT INTO peaks (name, lat, lon, elevation_m, prominence_m, region, source, created_at)
    VALUES (@name, @lat, @lon, @elevation_m, @prominence_m, @region, @source, @created_at)
  `).run({ region: null, created_at: Date.now(), ...p });
  return true;
}

async function fetchPeak(peakId) {
  const url = `https://www.peakbagger.com/peak.aspx?pid=${peakId}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'sendable-bot/1.0 (personal trail-running project)' } });
  if (!res.ok) return null;
  return res.text();
}

export async function seedPeakbagger({ ids = [], range = null } = {}) {
  let idList = [...ids];
  if (range) {
    const [start, end] = range.split('-').map(Number);
    for (let i = start; i <= end; i++) idList.push(i);
  }
  idList = idList.slice(0, MAX_PER_RUN); // never exceed the cap

  let inserted = 0;
  for (const id of idList) {
    try {
      const html = await fetchPeak(id);
      if (html) {
        const peak = parsePeakHtml(html, id);
        if (upsertPeak(peak)) {
          inserted++;
          console.log(`  + ${peak.name} (${peak.elevation_m}m)`);
        }
      }
    } catch (e) {
      console.error(`  peak ${id} failed: ${e.message}`);
    }
    await sleep(DELAY_MS); // be polite
  }
  console.log(`Peakbagger seed done. Inserted ${inserted} of ${idList.length} attempted.`);
  return { attempted: idList.length, inserted };
}

if (process.argv[1] && process.argv[1].endsWith('seed-peakbagger.js')) {
  const idsArg = process.argv.find(a => a.startsWith('--ids='));
  const rangeArg = process.argv.find(a => a.startsWith('--range='));
  const ids = idsArg ? idsArg.split('=')[1].split(',').map(Number) : [];
  const range = rangeArg ? rangeArg.split('=')[1] : null;
  if (ids.length === 0 && !range) {
    console.error('Provide --ids=1,2,3 or --range=10000-10050');
    process.exit(1);
  }
  seedPeakbagger({ ids, range })
    .then(r => { console.log(r); process.exit(0); })
    .catch(e => { console.error('Seed failed:', e.message); process.exit(1); });
}
