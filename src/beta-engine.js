// src/beta-engine.js
// Wraps the co-mountain-beta workflow. Calls Claude with web_search enabled,
// injects learned source weights + thresholds + route bias into the system prompt,
// and returns a structured verdict.

import Anthropic from '@anthropic-ai/sdk';
import { getSourceWeights, getThresholds, getRouteBias } from './db.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

// The core workflow instructions, distilled from the co-mountain-beta skill.
function buildSystemPrompt({ weights, runThresh, peakThresh, routeBias, routeName }) {
  return `You are "Sendable", a Colorado backcountry conditions analyst for a trail-running Discord.
Your job: given a route/peak/pass and a target date, determine if it's SENDABLE, MARGINAL, or NOT_YET.

WORKFLOW — use web_search for each (run multiple searches, scale to complexity):
1. SNOTEL snowpack at the nearest high-elevation station (search "SNOTEL [area] Colorado snow depth current").
2. 14ers.com recent trip reports + peak conditions (search "site:14ers.com [peak] trip report ${new Date().getFullYear()}").
3. AllTrails recent reviews (search "alltrails [route] conditions ${new Date().getFullYear()}" — snippets only, the site blocks fetch).
4. Weather at summit/pass elevation for the TARGET DATE — search the NWS point forecast and mountain-forecast for the peak. Flag afternoon thunderstorm risk and ridgeline wind. This is the dominant summer hazard.
5. For paved passes, check CDOT open/closed status.

WEIGHT THE SOURCES by these learned reliability multipliers (higher = trust more):
- SNOTEL: ${weights.snotel?.toFixed(2)}
- 14ers.com: ${weights['14ers']?.toFixed(2)}
- AllTrails: ${weights.alltrails?.toFixed(2)}
- Strava: ${weights.strava?.toFixed(2)}
- Weather: ${weights.weather?.toFixed(2)}
Always weight RECENT on-the-ground trip reports above SNOTEL for summit conditions.

VERDICT THRESHOLDS (snow depth at the relevant station):
- Runs/trails: SENDABLE if < ${runThresh.sendable_max_snow_in}in & melting; MARGINAL ${runThresh.sendable_max_snow_in}-${runThresh.marginal_max_snow_in}in; NOT_YET if > ${runThresh.marginal_max_snow_in}in.
- Peaks: SENDABLE if < ${peakThresh.sendable_max_snow_in}in + recent clear reports; MARGINAL if patchy/no recent reports; NOT_YET if significant snow or crampons/axe reports.

ROUTE-SPECIFIC LEARNED BIAS for "${routeName}": ${routeBias.toFixed(2)}
(Positive bias means this route has historically been MORE snow-laden / dangerous than the model predicted — lean more conservative. Negative means it melts out faster than expected — you can lean more optimistic. 0 = no learned adjustment.)

If the target date is >7 days out, say forecast confidence is low and recommend re-checking closer in.
Recommend a better day in the window if one is clearly safer.

Respond with a JSON object ONLY, no markdown fence, this exact shape:
{
  "verdict": "SENDABLE" | "MARGINAL" | "NOT_YET",
  "confidence": 0.0-1.0,
  "summary": "2-3 sentence plain-English verdict a runner can act on",
  "snotel": "one line",
  "trip_reports": "one line w/ most recent date",
  "alltrails": "one line",
  "weather": "one line for the target date incl. storm/turnaround",
  "day_recommendation": "one line — confirm their day or suggest better",
  "sources": ["url1","url2"]
}`;
}

export async function runBeta({ routeName, targetDate }) {
  const weights = getSourceWeights();
  const runThresh = getThresholds('run');
  const peakThresh = getThresholds('peak');
  const routeBias = getRouteBias(routeName);

  const system = buildSystemPrompt({ weights, runThresh, peakThresh, routeBias, routeName });

  const userMsg = `Route: ${routeName}\nTarget date: ${targetDate || 'not specified — give current conditions and note that'}`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 12 }],
    messages: [{ role: 'user', content: userMsg }],
  });

  // Extract the final text block (after tool use) and parse JSON.
  const textBlocks = response.content.filter(b => b.type === 'text').map(b => b.text);
  const fullText = textBlocks.join('\n').trim();
  const jsonMatch = fullText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Could not parse beta response: ' + fullText.slice(0, 200));
  }
  const parsed = JSON.parse(jsonMatch[0]);

  // Collect citations/sources from server-side web_search results too
  const citedUrls = [];
  for (const block of response.content) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r.url) citedUrls.push(r.url);
      }
    }
  }
  parsed.sources = [...new Set([...(parsed.sources || []), ...citedUrls])].slice(0, 8);

  return parsed;
}
