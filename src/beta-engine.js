// src/beta-engine.js
// Route-AWARE beta engine. Distinguishes WHICH route on a peak is meant
// (e.g. "Yale 360" loop vs the standard Yale out-and-back) so it doesn't
// report standard-route conditions as if they apply to a loop/traverse/ridge.

import Anthropic from '@anthropic-ai/sdk';
import { getSourceWeights, getThresholds, getRouteBias, findRoute, getRouteNotes } from './db.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

// Qualifiers that signal the user means a NON-standard route, where
// standard-route conditions do not transfer.
const VARIANT_KEYWORDS = [
  '360', 'loop', 'traverse', 'ridge', 'linkup', 'link-up', 'link up',
  'couloir', 'gully', 'direct', 'circuit', 'grand', 'tour', 'horseshoe',
  'east ridge', 'west ridge', 'north ridge', 'south ridge', 'nolan',
];

function detectVariant(routeName) {
  const lower = routeName.toLowerCase();
  return VARIANT_KEYWORDS.some(k => lower.includes(k));
}

function buildRouteContext(storedRoute, isVariant, routeName) {
  if (storedRoute) {
    return `
STORED ROUTE DEFINITION for "${storedRoute.canonical_name}" — THIS is the route the user means, NOT the standard route on this peak:
- Peak/area: ${storedRoute.peak || 'n/a'}
- Type: ${storedRoute.route_type || 'n/a'}
- Distance/gain: ${storedRoute.distance_km ?? '?'} km / ${storedRoute.gain_m ?? '?'} m
- Distinguishing terrain: ${storedRoute.key_terrain || 'n/a'}
- Aspects that hold snow / matter: ${storedRoute.aspects || 'n/a'}
- Why standard-route beta does NOT transfer: ${storedRoute.distinct_from_standard || 'n/a'}

You MUST evaluate conditions for THIS specific route. A trip report for the standard out-and-back on the same peak is NOT a valid answer unless it specifically covers the terrain above.`;
  }
  if (isVariant) {
    return `
The query "${routeName}" contains a route qualifier (loop / traverse / ridge / linkup / couloir / etc.), which means the user does NOT mean the standard out-and-back on this peak. You do not have a stored definition for it, so:
1. Search specifically for the named variant (e.g. "${routeName} conditions", "${routeName} trip report"), not just the peak name.
2. If you can only find standard-route reports, you must NOT present them as the answer. Label them explicitly as standard-route proxy data, and infer the variant's likely conditions from its probable terrain (longer, more off-trail, more north-facing ridge exposure than the standard route).`;
  }
  return `This appears to be a standard route. Search normally for current conditions on "${routeName}".`;
}

function buildSystemPrompt({ weights, runThresh, peakThresh, routeBias, routeName, routeContext }) {
  const yr = new Date().getFullYear();
  return `You are "Sendable", a Colorado backcountry conditions analyst for a trail-running Discord.
Determine if the SPECIFIC route requested is SENDABLE, MARGINAL, or NOT_YET.

═══════════════════════════════════════════════════════════
SAFETY MANDATE — READ FIRST. PEOPLE'S LIVES DEPEND ON THIS.
═══════════════════════════════════════════════════════════
Wrong information here can lead to serious injury or death (avalanche, cornice collapse, postholing into creeks, falls on snow-covered technical terrain, exposure, lightning, hypothermia). Therefore:

1. ERR CONSERVATIVE. When data is thin, stale, conflicting, or absent, lean toward MARGINAL or NOT_YET. NEVER resolve uncertainty toward SENDABLE. The cost of a wrong "NOT_YET" is a missed run; the cost of a wrong "SENDABLE" is a body recovery.

2. NEVER FABRICATE. If you lack a real, recent, source-backed data point, say so. Do not invent snow depths, temps, trip-report contents, or dates. If web_search returns nothing usable for a field, write "no current data found" — never a plausible guess.

3. STATE DATA AGE AND GAPS. Always give the date of your most recent ON_ROUTE evidence. If it is >10 days old or pre-dates a recent storm, say the route may have changed and you cannot confirm current conditions.

4. NAME THE HAZARDS EXPLICITLY for the specific route/season: avalanche & wet-slide risk on loaded slopes, cornices, snow bridges over creeks, postholing, verglas/ice, snow-covered technical sections, exposure, and afternoon thunderstorms. For anything involving snow travel, tell the user to check the CAIC avalanche forecast (avalanche.state.co.us) — you are NOT an avalanche forecast.

5. NEVER tell anyone it is safe. You assess CONDITIONS, not safety. "SENDABLE" means conditions appear favorable per available data — it is NOT a go-ahead and NOT a safety guarantee. Every verdict must carry that framing.

6. SENDABLE REQUIRES POSITIVE, RECENT, ON_ROUTE EVIDENCE. You may only return SENDABLE when you have recent (ideally <7 days) on-route data affirmatively indicating clear/passable conditions. Absence of bad reports is NOT evidence of good conditions — that is MARGINAL at best, with the gap stated.

CRITICAL — ROUTE PRECISION:
${routeContext}

Never let a "perfect conditions" report for the wrong route drive the verdict. Tag every report you use as one of: ON_ROUTE (covers the requested route), PARTIAL (covers some shared terrain), or WRONG_ROUTE (different route on same peak). Base the verdict on ON_ROUTE/PARTIAL evidence; mention WRONG_ROUTE reports only as weak proxy and say so.

WORKFLOW — use web_search (multiple targeted searches):
1. SNOTEL snowpack at the nearest high-elevation station.
2. 14ers.com trip reports — search for the SPECIFIC route/variant first, then the peak.
3. AllTrails recent reviews (snippets only).
4. Weather at summit/pass elevation for the TARGET DATE — NWS point forecast + mountain-forecast. Flag afternoon thunderstorm risk + ridgeline wind.
5. For paved passes, CDOT status. For any snow travel, point to the CAIC forecast.

SOURCE RELIABILITY multipliers (higher = trust more): SNOTEL ${weights.snotel?.toFixed(2)}, 14ers ${weights['14ers']?.toFixed(2)}, AllTrails ${weights.alltrails?.toFixed(2)}, Strava ${weights.strava?.toFixed(2)}, Weather ${weights.weather?.toFixed(2)}. Weight RECENT on-route trip reports above SNOTEL for summits.

THRESHOLDS: Runs SENDABLE <${runThresh.sendable_max_snow_in}in & melting, MARGINAL ${runThresh.sendable_max_snow_in}-${runThresh.marginal_max_snow_in}in, NOT_YET >${runThresh.marginal_max_snow_in}in. Peaks SENDABLE <${peakThresh.sendable_max_snow_in}in + recent clear ON_ROUTE reports, NOT_YET if crampons/axe reports or significant snow.

ROUTE-SPECIFIC LEARNED BIAS for "${routeName}": ${routeBias.toFixed(2)} (positive = lean conservative, this route holds snow / is more dangerous than the model predicts).

If target date >7 days out, say forecast confidence is low. Recommend a safer day in the window if one exists.

Respond with JSON ONLY, no markdown fence, this exact shape:
{
  "verdict": "SENDABLE" | "MARGINAL" | "NOT_YET",
  "confidence": 0.0-1.0,
  "route_match": "matched a stored/variant route" | "standard route" | "could only find standard-route proxy data",
  "summary": "2-3 sentence verdict for THIS route. Must frame as conditions assessment, not safety clearance. Flag if data was proxy or stale.",
  "data_age": "date of most recent ON_ROUTE evidence, e.g. 'most recent on-route report: June 8 (7 days ago)' or 'no on-route data in last 30 days'",
  "hazards": "explicit named hazards for this route/season: avalanche, cornices, snow bridges, postholing, ice, exposure, lightning, etc. Never leave empty for an alpine route.",
  "snotel": "one line",
  "trip_reports": "one line w/ most recent date AND whether ON_ROUTE or WRONG_ROUTE",
  "alltrails": "one line",
  "weather": "one line for the target date incl. storm/turnaround",
  "day_recommendation": "one line",
  "sources": ["url1","url2"]
}

Reminder: if you cannot find recent on-route evidence, the verdict cannot be SENDABLE, and summary + data_age must say so plainly.`;
}

export async function runBeta({ routeName, targetDate }) {
  const weights = getSourceWeights();
  const runThresh = getThresholds('run');
  const peakThresh = getThresholds('peak');
  const routeBias = getRouteBias(routeName);

  const storedRoute = findRoute(routeName);
  const isVariant = detectVariant(routeName);
  const routeContext = buildRouteContext(storedRoute, isVariant, routeName);

  // Pull real field reports our own users submitted for this route.
  const notes = getRouteNotes(routeName, 5);
  let communityBlock = '';
  if (notes.length > 0) {
    const formatted = notes.map(n => {
      const when = n.ground_truth_date || new Date(n.created_at).toISOString().slice(0, 10);
      return `- [${when}] reported it ${n.corrected_verdict || '?'}: "${(n.note || '').slice(0, 400)}"`;
    }).join('\n');
    communityBlock = `

COMMUNITY FIELD REPORTS for this route (submitted by our own runners — treat as HIGH-VALUE, on-the-ground ground truth, weighted above generic web sources; the most recent one matters most, but note its date and whether conditions may have changed since):
${formatted}`;
  }

  const system = buildSystemPrompt({ weights, runThresh, peakThresh, routeBias, routeName, routeContext })
    + communityBlock;
  const userMsg = `Route: ${routeName}\nTarget date: ${targetDate || 'not specified — give current conditions and note that'}`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 12 }],
    messages: [{ role: 'user', content: userMsg }],
  });

  const textBlocks = response.content.filter(b => b.type === 'text').map(b => b.text);
  const fullText = textBlocks.join('\n').trim();
  const jsonMatch = fullText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Could not parse beta response: ' + fullText.slice(0, 200));
  const parsed = JSON.parse(jsonMatch[0]);

  const citedUrls = [];
  for (const block of response.content) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) if (r.url) citedUrls.push(r.url);
    }
  }
  parsed.sources = [...new Set([...(parsed.sources || []), ...citedUrls])].slice(0, 8);
  parsed._stored_route = storedRoute ? storedRoute.canonical_name : null;
  parsed._is_variant = isVariant;
  return parsed;
}
