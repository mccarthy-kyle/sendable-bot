// src/seed-cotrex.js
// Bulk-import Colorado trails from COTREX (Colorado Trail Explorer), the state's
// official open-data trail layer, served as an ArcGIS REST FeatureService.
//
// This is the BACKBONE seed: maintained, named trails with reliable metadata
// (name, length, use type/manager). It does NOT invent off-trail linkups or
// informal route names — those come from /defineroute. Re-runnable: dedupes by name.
//
// Usage:
//   node src/seed-cotrex.js                     (whole state — ~40k trails, noisy)
//   node src/seed-cotrex.js --region=sawatch    (one alpine range, recommended)
//   node src/seed-cotrex.js --regions=sawatch,sangre,san_juan,elk,mosquito,front
//                                               (all alpine ranges, skips urban noise)
//
// Region filtering is done server-side via an ArcGIS spatial envelope query
// (bounding boxes from co-regions.js), so we only pull trails in the ranges you
// care about instead of every urban greenway in the state. Trails are tagged
// with their region.
//
// Env:
//   COTREX_URL  override the FeatureServer layer query endpoint if the mirror changes.

import { db, normalizeRoute } from './db.js';
import { REGIONS } from './co-regions.js';

const COTREX_LAYER = process.env.COTREX_URL
  || 'https://services3.arcgis.com/0jWpHMuhmHsukKE3/arcgis/rest/services/CPW_Trails_08222024/FeatureServer/0';

const PAGE = 1000;

// ArcGIS expects envelope geometry in the layer's spatial reference. COTREX is
// Web Mercator (wkid 102100/3857), so we convert lat/lon bbox -> meters.
function lonLatToMeters(lon, lat) {
  const x = lon * 20037508.34 / 180;
  let y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180);
  y = y * 20037508.34 / 180;
  return { x, y };
}

function regionEnvelope(region) {
  const r = REGIONS[region];
  if (!r) throw new Error(`Unknown region "${region}". Options: ${Object.keys(REGIONS).join(', ')}`);
  const sw = lonLatToMeters(r.bbox.lonMin, r.bbox.latMin);
  const ne = lonLatToMeters(r.bbox.lonMax, r.bbox.latMax);
  return { xmin: sw.x, ymin: sw.y, xmax: ne.x, ymax: ne.y, spatialReference: { wkid: 102100 } };
}

function buildQueryUrl(layer, { offset = 0, fields = '*', envelope = null } = {}) {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: fields,
    returnGeometry: 'false',
    resultOffset: String(offset),
    resultRecordCount: String(PAGE),
    f: 'json',
  });
  if (envelope) {
    params.set('geometry', JSON.stringify(envelope));
    params.set('geometryType', 'esriGeometryEnvelope');
    params.set('spatialRel', 'esriSpatialRelIntersects');
    params.set('inSR', '102100');
  }
  return `${layer}/query?${params.toString()}`;
}

async function discoverFields(layer) {
  const res = await fetch(`${layer}?f=json`);
  if (!res.ok) throw new Error(`COTREX layer metadata fetch failed: HTTP ${res.status}`);
  const meta = await res.json();
  const fields = (meta.fields || []).map(f => f.name);
  const pick = (cands) => cands.find(c => fields.some(f => f.toLowerCase() === c.toLowerCase()))
    || cands.find(c => fields.some(f => f.toLowerCase().includes(c.toLowerCase())));
  return {
    nameField: pick(['name', 'trail_name', 'trailname']) || 'name',
    lengthField: pick(['length_mi_', 'length_miles', 'miles', 'length', 'gis_miles']),
    typeField: pick(['type', 'trail_type', 'surface', 'trail_class']),
    useField: pick(['use', 'allowed_use', 'manager', 'managing_org', 'admin_org']),
  };
}

async function fetchPage(layer, offset, envelope) {
  const url = buildQueryUrl(layer, { offset, envelope });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`COTREX query failed: HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`COTREX API error: ${JSON.stringify(json.error)}`);
  return json.features || [];
}

function upsertTrail(attrs, fieldMap, region) {
  const name = attrs[fieldMap.nameField];
  if (!name || !String(name).trim()) return false;
  const canonical = String(name).trim();
  const norm = normalizeRoute(canonical);
  const existing = db.prepare(`SELECT id FROM routes WHERE LOWER(canonical_name) = ?`).get(norm);
  if (existing) return false;

  const rawMiles = fieldMap.lengthField ? attrs[fieldMap.lengthField] : null;
  const km = rawMiles != null && !isNaN(rawMiles) ? Number(rawMiles) * 1.60934 : null;
  const useType = fieldMap.useField ? attrs[fieldMap.useField] : null;
  const trailType = fieldMap.typeField ? attrs[fieldMap.typeField] : null;

  db.prepare(`
    INSERT INTO routes (canonical_name, aliases, peak, route_type, distance_km, gain_m,
      key_terrain, aspects, distinct_from_standard, lat, lon, elevation_m, region, source, created_by, created_at)
    VALUES (@canonical_name, @aliases, @peak, @route_type, @distance_km, @gain_m,
      @key_terrain, @aspects, @distinct_from_standard, @lat, @lon, @elevation_m, @region, @source, @created_by, @created_at)
  `).run({
    canonical_name: canonical,
    aliases: JSON.stringify([]),
    peak: null,
    route_type: trailType || 'trail',
    distance_km: km ? Math.round(km * 10) / 10 : null,
    gain_m: null,
    key_terrain: useType ? `COTREX trail. Managed use/agency: ${useType}.` : 'COTREX-mapped trail segment.',
    aspects: null,
    distinct_from_standard: 'Imported from COTREX as a maintained trail. Needs enrichment for route-level conditions (run /defineroute to add terrain/aspect detail).',
    lat: null, lon: null, elevation_m: null,
    region: region || null,
    source: 'cotrex',
    created_by: 'seed',
    created_at: Date.now(),
  });
  return true;
}

async function seedOneScope(fieldMap, { region = null } = {}) {
  const envelope = region ? regionEnvelope(region) : null;
  let offset = 0, inserted = 0, scanned = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const features = await fetchPage(COTREX_LAYER, offset, envelope);
    if (features.length === 0) break;
    const tx = db.transaction((feats) => {
      for (const feat of feats) {
        scanned++;
        if (upsertTrail(feat.attributes || {}, fieldMap, region)) inserted++;
      }
    });
    tx(features);
    offset += features.length;
    if (features.length < PAGE) break;
  }
  return { scanned, inserted };
}

export async function seedCotrex({ region = null, regions = null } = {}) {
  console.log('Seeding from COTREX:', COTREX_LAYER);
  const fieldMap = await discoverFields(COTREX_LAYER);
  console.log('Resolved fields:', fieldMap);

  let scopes;
  if (regions) scopes = regions;
  else if (region) scopes = [region];
  else scopes = [null]; // whole state

  let totalScanned = 0, totalInserted = 0;
  for (const scope of scopes) {
    const label = scope || 'whole state';
    console.log(`Scope: ${label}...`);
    const { scanned, inserted } = await seedOneScope(fieldMap, { region: scope });
    console.log(`  ${label}: scanned ${scanned}, inserted ${inserted} new`);
    totalScanned += scanned; totalInserted += inserted;
  }
  console.log(`COTREX seed complete. Scanned ${totalScanned}, inserted ${totalInserted} new trails.`);
  return { scanned: totalScanned, inserted: totalInserted };
}

if (process.argv[1] && process.argv[1].endsWith('seed-cotrex.js')) {
  const regionArg = process.argv.find(a => a.startsWith('--region='));
  const regionsArg = process.argv.find(a => a.startsWith('--regions='));
  const opts = {};
  if (regionsArg) opts.regions = regionsArg.split('=')[1].split(',').map(s => s.trim());
  else if (regionArg) opts.region = regionArg.split('=')[1];
  seedCotrex(opts)
    .then(r => { console.log(r); process.exit(0); })
    .catch(e => { console.error('Seed failed:', e.message); process.exit(1); });
}
