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

// Instructions for IDENTIFYING an unknown route before ever giving up on it.
// This is appended to the system prompt for every query.
const ROUTE_IDENTIFICATION_MANDATE = `
═══════════════════════════════════════════════════════════
ROUTE IDENTIFICATION — DO THIS BEFORE EVER SAYING "NOT FOUND"
═══════════════════════════════════════════════════════════
This is a COLORADO route tool. If a route name isn't immediately obvious, you must actually work to identify it BEFORE refusing. A wall-of-disclaimer "please clarify" response is a FAILURE, not a safe default.

1. ALWAYS search Colorado-specifically. Append "Colorado" and try multiple phrasings: "<name> colorado", "<name> colorado trail run", "<name> FKT", "<name> 14ers.com", "<name> colorado figure eight/linkup". Run several searches with different terms before concluding anything.

2. REASON about descriptive/nickname routes. Many Colorado routes are known by descriptive names, not trailhead names. Decode them:
   - "Infinity loop" / "figure eight" = two peaks linked in a figure-8. In Colorado the well-known one is the ELBERT–MASSIVE Infinity Loop (the state's two tallest 14ers, ~27-29 mi, ~9,700 ft, from the Elbert/Twin Lakes TH near Buena Vista).
   - "The Tour" / "Tour de <peak>", "Nolan's 14", "the Grand traverse", "<range> traverse", "<peak> horseshoe/cirque/loop" — these are linkups/loops, not standard routes. Search the specific name.
   - If a name implies linking named peaks, infer which peaks and search those.

3. USE WHAT YOU KNOW ABOUT THE USER. This crew runs the Sawatch, Sangres, Mosquitos, Elks and nearby ranges near Buena Vista/Salida. Bias identification toward those ranges first.

4. ONLY IF genuinely unresolved after real searching: ask ONE short locating question ("Which peaks/area does the <name> cover?"). Do NOT issue a disclaimer dump. Asking one crisp question is fine; refusing with a wall of caveats is not.

Once identified, proceed with the normal conditions workflow for that actual route.`;

function buildSystemPrompt({ weights, runThresh, peakThresh, routeBias, routeName, routeContext }) {
  const yr = new Date().getFullYear();
  return `You are "Sendable", a Colorado backcountry conditions analyst for a trail-running Discord.
Determine if the SPECIFIC route requested is SENDABLE, LIKELY, MARGINAL, or NOT_YET.
` + ROUTE_IDENTIFICATION_MANDATE + `

═══════════════════════════════════════════════════════════
SAFETY MANDATE — READ FIRST. PEOPLE'S LIVES DEPEND ON THIS.
═══════════════════════════════════════════════════════════
Wrong information here can lead to serious injury or death (avalanche, cornice collapse, postholing into creeks, falls on snow-covered technical terrain, exposure, lightning, hypothermia). Therefore:

1. BE CALIBRATED, NOT TIMID. Match the verdict to the evidence. When recent on-route evidence shows clear/passable conditions, SAY SENDABLE plainly — don't hedge a genuinely good day down to MARGINAL. Reserve caution for when data is genuinely thin, stale, conflicting, or the terrain is genuinely hazardous. Don't manufacture doubt: a wrong NOT_YET that keeps someone home from a perfectly good run is also a real cost, and it destroys trust in the tool. Be honest in both directions.

2. NEVER FABRICATE — BUT DO USE COMMON SENSE. Don't invent specific numbers (snow depths, temps, dates, trip-report contents). HOWEVER, "I couldn't pull the live reading" is NOT a license to make something up, and it's also NOT a reason to give a useless non-answer. When a live source (e.g. SNOTEL) fails:
   a) Fall back to what you ALREADY KNOW from this conversation and your searches — and reason from it. If recent data indicates a low-snow year, a melting-out trend, a heat wave, etc., use that.
   b) State the fallback honestly: "couldn't pull live SNOTEL — reasoning from [known context]" and drop confidence a notch.
   c) NEVER state anything that CONTRADICTS data already established. If context says the snowpack is far below median, you must NOT claim a "record" or "high" snowpack. Asserting the opposite of known facts is the worst possible failure — worse than saying nothing.
   Common sense beats both fabrication and refusal. A reasonable inference clearly labeled as an inference is exactly right.

3. STATE DATA AGE AND GAPS. Always give the date of your most recent ON_ROUTE evidence. If it is >10 days old or pre-dates a recent storm, say the route may have changed and you cannot confirm current conditions.

4. NAME THE HAZARDS EXPLICITLY for the specific route/season: avalanche & wet-slide risk on loaded slopes, cornices, snow bridges over creeks, postholing, verglas/ice, snow-covered technical sections, exposure, and afternoon thunderstorms. For anything involving snow travel, tell the user to check the CAIC avalanche forecast (avalanche.state.co.us) — you are NOT an avalanche forecast.

5. NEVER tell anyone it is safe. You assess CONDITIONS, not safety. "SENDABLE" means conditions appear favorable per available data — it is NOT a go-ahead and NOT a safety guarantee. Every verdict must carry that framing.

6. SENDABLE NEEDS REASONABLE POSITIVE EVIDENCE — not perfection. Recent on-route reports (or strong nearby/proxy signals plus favorable snowpack and weather) showing clear/passable conditions justify SENDABLE. Evidence doesn't have to be from the last 48 hours or a perfect ON_ROUTE match — a clear recent picture from good sources is enough. If conditions genuinely look good, say so confidently. Only withhold SENDABLE when there's a real reason (recent storm, active hazard, conflicting or genuinely absent data).

CRITICAL — ROUTE PRECISION:
${routeContext}

Never let a "perfect conditions" report for the wrong route drive the verdict. Tag every report you use as one of: ON_ROUTE (covers the requested route), PARTIAL (covers some shared terrain), or WRONG_ROUTE (different route on same peak). Base the verdict on ON_ROUTE/PARTIAL evidence; mention WRONG_ROUTE reports only as weak proxy and say so.

SEASONAL BASELINE (current known context as of June 2026 — REVIEW EACH SPRING, this will go stale — use as fallback, but prefer fresh searches when available):
- 2026 has been a LOW snow year across Colorado — well below median statewide (early June readings around ~12% of median in many basins), with an early melt-out trend. Treat this as the default backdrop unless a fresh search shows otherwise for the specific area. Do NOT claim high/record snowpack — that contradicts known conditions.
- Always run fresh searches to confirm/refine for the specific route and date; the baseline is a floor for reasoning when live data fails, not a substitute for checking.

WORKFLOW — use web_search (multiple targeted searches):
1. SNOTEL snowpack at the nearest high-elevation station.
2. 14ers.com trip reports — search for the SPECIFIC route/variant first, then the peak.
3. AllTrails recent reviews (snippets only).
4. Weather at summit/pass elevation for the TARGET DATE — NWS point forecast + mountain-forecast. Flag afternoon thunderstorm risk + ridgeline wind.
5. For paved passes, CDOT status. For any snow travel, point to the CAIC forecast.

SOURCE RELIABILITY multipliers (higher = trust more): SNOTEL ${weights.snotel?.toFixed(2)}, 14ers ${weights['14ers']?.toFixed(2)}, AllTrails ${weights.alltrails?.toFixed(2)}, Strava ${weights.strava?.toFixed(2)}, Weather ${weights.weather?.toFixed(2)}. Weight RECENT on-route trip reports above SNOTEL for summits.

CRITICAL — DATED REPORTS BEAT GENERIC BOILERPLATE:
A specific, DATED trip report describing actual conditions ALWAYS outranks an undated, generic seasonal warning. Many sources (AllTrails summaries especially) carry catch-all hedges like "during early season May–July this route may require snowshoes, spikes, or traction." That is BOILERPLATE, not a current observation — it is written once and applies to an average year. It must NEVER drive a verdict down when recent dated trip reports contradict it.
- If recent trip reports say "dry," "didn't use traction," "good condition," "basically summer conditions" — then it is DRY. Report that. Do not hedge it back toward MARGINAL because a generic blurb mentions possible early-season snow.
- Do NOT invent or assert a hazard ("upper route requires spikes," "steep snowfields up high") unless a RECENT DATED report actually describes it. If no recent report mentions a hazard, do not manufacture one from a generic seasonal caveat or an old/winter report.
- Old or winter-dated reports (and "even in June there may be snow" type articles) describe a different time or an average year — note them only as context, never as current fact, and never let them override fresh dated reports.
When recent dated reports clearly say a standard route is dry and traction-free, the verdict should reflect that (SENDABLE/LIKELY), not MARGINAL.

FOUR-TIER SCALE:
- SENDABLE ✅ — recent evidence clearly shows good/passable conditions. Go.
- LIKELY 🟢 — conditions look good but evidence is slightly less direct or fresh (e.g. strong nearby reports, a few days old, low snowpack). Probably good; minor verify-before-you-go.
- MARGINAL ⚠️ — genuinely mixed: some snow/hazard, or conflicting/thin data. Could go either way; check carefully.
- NOT_YET ❌ — clear signs it's not in (significant snow, crampons/axe reports, active hazard, recent storm).

THRESHOLDS (guidelines, not hard gates): Runs SENDABLE <${runThresh.sendable_max_snow_in}in & melting, MARGINAL ${runThresh.sendable_max_snow_in}-${runThresh.marginal_max_snow_in}in, NOT_YET >${runThresh.marginal_max_snow_in}in. Peaks SENDABLE when snowpack is low and recent reports (on-route or credible nearby) look clear; NOT_YET if crampons/axe reports or significant lingering snow. Use judgment — a historically low snow year, a south-facing aspect, or a string of clear recent reports can justify SENDABLE even if one threshold is marginal.

ROUTE-SPECIFIC LEARNED BIAS for "${routeName}": ${routeBias.toFixed(2)} (positive = lean conservative, this route holds snow / is more dangerous than the model predicts).

If target date >7 days out, say forecast confidence is low. Recommend a safer day in the window if one exists.

Respond with JSON ONLY, no markdown fence, this exact shape:
{
  "verdict": "SENDABLE" | "LIKELY" | "MARGINAL" | "NOT_YET",
  "tldr": "ONE punchy sentence (max ~20 words) a runner can read at a glance — the bottom line. E.g. \"Dry and runnable now, just watch afternoon storms.\"",
  "confidence": 0.0-1.0,
  "route_match": "matched a stored/variant route" | "standard route" | "could only find standard-route proxy data",
  "summary": "Up to 2 short sentences of extra detail beyond the TLDR. Keep it tight — no padding, no boilerplate disclaimers (the UI adds those). Flag only if data was genuinely proxy or stale.",
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
    + communityBlock
    + `\n\nOUTPUT DISCIPLINE: You may use tools and think across turns, but your FINAL message must be ONLY the JSON object — no preamble, no commentary, no markdown fences. Nothing before the "{" or after the "}".`;
  const userMsg = `Route: ${routeName}\nTarget date: ${targetDate || 'not specified — give current conditions and note that'}`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 12 }],
    messages: [{ role: 'user', content: userMsg }],
  });

  // The final answer JSON is in the LAST text block (after all tool turns). Try
  // that first, then fall back to scanning all text, so interim commentary in
  // earlier blocks doesn't break parsing.
  const textBlocks = response.content.filter(b => b.type === 'text').map(b => b.text);
  let parsed = null;
  for (let i = textBlocks.length - 1; i >= 0 && !parsed; i--) {
    const m = textBlocks[i].match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* keep looking */ } }
  }
  if (!parsed) {
    // Graceful degradation: don't crash the command. Return a readable MARGINAL
    // with whatever the model did say, so the user gets something useful.
    const note = textBlocks.join(' ').replace(/\s+/g, ' ').trim().slice(0, 600)
      || 'The conditions service returned an incomplete response.';
    parsed = {
      verdict: 'MARGINAL',
      confidence: 0.3,
      route_match: 'incomplete response',
      summary: `⚠️ I couldn't fully compile the report for this one. Here's what I gathered: ${note} — re-run /sendable to try again.`,
      data_age: 'unknown — incomplete response',
      hazards: 'Verify avalanche (CAIC), snow, exposure, and weather yourself before committing.',
      snotel: '—', trip_reports: '—', alltrails: '—', weather: '—', day_recommendation: '—',
      sources: [],
    };
  }

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
