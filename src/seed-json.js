// src/seed-json.js
// Import routes from a JSON file (array of route objects) into the routes table.
// Used for the Strava-activity seed and any hand-curated seed file.
// Re-runnable: dedupes by normalized canonical_name.
//
// Usage:  node src/seed-json.js seeds/strava-routes.json

import fs from 'fs';
import path from 'path';
import { db, saveRoute, normalizeRoute } from './db.js';

export function seedJson(filePath) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`Seed file not found: ${abs}`);
  const rows = JSON.parse(fs.readFileSync(abs, 'utf8'));
  if (!Array.isArray(rows)) throw new Error('Seed file must be a JSON array of route objects');

  let inserted = 0, skipped = 0;
  const exists = db.prepare(`SELECT id FROM routes WHERE LOWER(canonical_name) = ?`);
  const tx = db.transaction((items) => {
    for (const r of items) {
      if (!r.canonical_name) { skipped++; continue; }
      if (exists.get(normalizeRoute(r.canonical_name))) { skipped++; continue; }
      saveRoute({
        canonical_name: r.canonical_name,
        aliases: r.aliases || JSON.stringify([]),
        peak: r.peak ?? null,
        route_type: r.route_type ?? 'run',
        distance_km: r.distance_km ?? null,
        gain_m: r.gain_m ?? null,
        key_terrain: r.key_terrain ?? null,
        aspects: r.aspects ?? null,
        distinct_from_standard: r.distinct_from_standard ?? null,
        lat: r.lat ?? null,
        lon: r.lon ?? null,
        elevation_m: r.elevation_m ?? null,
        region: r.region ?? null,
        source: r.source ?? 'seed',
        created_by: r.created_by ?? 'seed',
        created_at: Date.now(),
      });
      inserted++;
    }
  });
  tx(rows);
  console.log(`JSON seed complete: ${inserted} inserted, ${skipped} skipped (dupes/invalid).`);
  return { inserted, skipped };
}

if (process.argv[1] && process.argv[1].endsWith('seed-json.js')) {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node src/seed-json.js <file.json>'); process.exit(1); }
  seedJson(file);
  process.exit(0);
}
