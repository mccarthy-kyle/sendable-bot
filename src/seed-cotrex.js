// src/seed-cotrex.js
// Bulk-import Colorado trails from COTREX (Colorado Trail Explorer), the state's
// official open-data trail layer, served as an ArcGIS REST FeatureService.
//
// This is the BACKBONE seed: it loads maintained, named trails statewide with
// reliable metadata (name, length, surface, use type, manager). It does NOT
// invent off-trail linkups or informal route names — those get enriched via
// /defineroute or the route-enricher. Re-runnable: upserts by name, skips dupes.
//
// Usage:  node src/seed-cotrex.js              (whole state)
//         node src/seed-cotrex.js --bbox=...   (limit to a bounding box)
//         node src/seed-cotrex.js --name="Colorado Trail"  (name filter)
//
// Env:
//   COTREX_URL  override the FeatureServer layer query endpoint if the public
//               mirror changes. Must point at a .../FeatureServer/<id> layer.

import { db, normalizeRoute } from './db.js';

// Default public COTREX trails layer (ArcGIS REST). Override with COTREX_URL.
const COTREX_LAYER = process.env.COTREX_URL
  || 'https://services3.arcgis.com/0jWpHMuhmHsukKE3/arcgis/rest/services/CPW_Trails_08222024/FeatureServer/0';

const PAGE = 1000; // ArcGIS MaxRecordCount is commonly 1000-2000

// ArcGIS REST returns geometry we don't need; we only want attributes.
function buildQueryUrl(layer, { where = '1=1', offset = 0, fields = '*' } = {}) {
  const params = new URLSearchParams({
    where,
    outFields: fields,
    returnGeometry: 'false',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE),
    f: 'json',
  });
  return `${layer}/query?${params.toString()}`;
}

// Discover which fields the layer actually has, so we map names robustly across
// COTREX mirror versions (field casing/names differ: name/TRAIL_NAME, length_mi_, etc.)
async function discoverFields(layer) {
  const res = await fetch(`${layer}?f=json`);
  if (!res.ok) throw new Error(`COTREX layer metadata fetch failed: HTTP ${res.status}`);
  const meta = await res.json();
  const fields = (meta.fields || []).map(f => f.name);
  const pick = (cands) => cands.find(c => fields.some(f => f.toLowerCase() === c.toLowerCase()))
    || cands.find(c => fields.some(f => f.toLowerCase().includes(c.toLowerCase())));
  return {
    all: fields,
    nameField: pick(['name', 'trail_name', 'trailname']) || 'name',
    lengthField: pick(['length_mi_', 'length_miles', 'miles', 'length', 'shape__length', 'gis_miles']),
    typeField: pick(['type', 'trail_type', 'surface', 'trail_class']),
    useField: pick(['use', 'allowed_use', 'manager', 'managing_org', 'admin_org']),
    displayField: meta.displayField || 'name',
  };
}

async function fetchPage(layer, fieldMap, offset) {
  const url = buildQueryUrl(layer, { offset });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`COTREX query failed: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`COTREX API error: ${JSON.stringify(json.error)}`);
  return json.features || [];
}

// Upsert into routes, keyed on normalized canonical_name, marking that this
// entry came from COTREX and still needs route-level enrichment.
function upsertTrail(attrs, fieldMap) {
  const name = attrs[fieldMap.nameField];
  if (!name || !String(name).trim()) return false;

  const canonical = String(name).trim();
  const norm = normalizeRoute(canonical);

  // Skip if we already have a route with this normalized name.
  const existing = db.prepare(`SELECT id FROM routes WHERE LOWER(canonical_name) = ?`).get(norm);
  if (existing) return false;

  const rawMiles = fieldMap.lengthField ? attrs[fieldMap.lengthField] : null;
  const km = rawMiles != null && !isNaN(rawMiles) ? Number(rawMiles) * 1.60934 : null;
  const useType = fieldMap.useField ? attrs[fieldMap.useField] : null;
  const trailType = fieldMap.typeField ? attrs[fieldMap.typeField] : null;

  db.prepare(`
    INSERT INTO routes (canonical_name, aliases, peak, route_type, distance_km, gain_m,
      key_terrain, aspects, distinct_from_standard, source, created_by, created_at)
    VALUES (@canonical_name, @aliases, @peak, @route_type, @distance_km, @gain_m,
      @key_terrain, @aspects, @distinct_from_standard, @source, @created_by, @created_at)
  `).run({
    canonical_name: canonical,
    aliases: JSON.stringify([]),
    peak: null,
    route_type: trailType || 'trail',
    distance_km: km ? Math.round(km * 10) / 10 : null,
    gain_m: null,
    key_terrain: useType ? `COTREX trail. Managed use/agency: ${useType}.` : 'COTREX-mapped trail segment.',
    aspects: null,
    distinct_from_standard: 'Imported from COTREX as a maintained trail. Needs enrichment for route-level conditions (run /defineroute or the enricher to add terrain/aspect detail).',
    source: 'cotrex',
    created_by: 'seed',
    created_at: Date.now(),
  });
  return true;
}

export async function seedCotrex() {
  console.log('Seeding from COTREX:', COTREX_LAYER);
  const fieldMap = await discoverFields(COTREX_LAYER);
  console.log('Resolved fields:', {
    name: fieldMap.nameField, length: fieldMap.lengthField,
    type: fieldMap.typeField, use: fieldMap.useField,
  });

  let offset = 0;
  let inserted = 0;
  let scanned = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const features = await fetchPage(COTREX_LAYER, fieldMap, offset);
    if (features.length === 0) break;
    const tx = db.transaction((feats) => {
      for (const feat of feats) {
        scanned++;
        if (upsertTrail(feat.attributes || {}, fieldMap)) inserted++;
      }
    });
    tx(features);
    offset += features.length;
    console.log(`  scanned ${scanned}, inserted ${inserted} new...`);
    if (features.length < PAGE) break; // last page
  }

  console.log(`COTREX seed complete. Scanned ${scanned}, inserted ${inserted} new trails.`);
  return { scanned, inserted };
}

// Run directly: node src/seed-cotrex.js
if (process.argv[1] && process.argv[1].endsWith('seed-cotrex.js')) {
  seedCotrex()
    .then(r => { console.log(r); process.exit(0); })
    .catch(e => { console.error('Seed failed:', e.message); process.exit(1); });
}
