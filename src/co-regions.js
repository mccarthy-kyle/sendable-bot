// src/co-regions.js
// Colorado mountain-range bounding boxes, used to tag peaks/routes by region
// from their coordinates. Boxes are approximate but reliable for tagging.
// (No peak IDs here anymore — peaks come from USGS GNIS, tagged by location.)

export const REGIONS = {
  sawatch:  { label: 'Sawatch Range',      bbox: { latMin: 38.5, latMax: 39.5, lonMin: -106.7, lonMax: -106.0 } },
  sangre:   { label: 'Sangre de Cristo',   bbox: { latMin: 37.4, latMax: 38.4, lonMin: -105.8, lonMax: -105.2 } },
  san_juan: { label: 'San Juan Mountains', bbox: { latMin: 37.4, latMax: 38.2, lonMin: -108.2, lonMax: -106.8 } },
  elk:      { label: 'Elk Mountains',      bbox: { latMin: 38.9, latMax: 39.3, lonMin: -107.2, lonMax: -106.7 } },
  mosquito: { label: 'Mosquito Range',     bbox: { latMin: 39.0, latMax: 39.5, lonMin: -106.3, lonMax: -105.9 } },
  front:    { label: 'Front Range',        bbox: { latMin: 39.5, latMax: 40.4, lonMin: -106.0, lonMax: -105.4 } },
};

export function regionForLatLon(lat, lon) {
  for (const [key, r] of Object.entries(REGIONS)) {
    const b = r.bbox;
    if (lat >= b.latMin && lat <= b.latMax && lon >= b.lonMin && lon <= b.lonMax) return key;
  }
  return null;
}
