// src/route-builder.js
// Turns a Strava link + AllTrails link + freeform description into a structured
// route definition the beta engine can use to disambiguate which route is meant.

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

export async function buildRouteDefinition({ name, stravaUrl, alltrailsUrl, description }) {
  const yr = new Date().getFullYear();

  // Let Claude fetch the public pages (Strava activity/route pages and AllTrails
  // are partly readable) and synthesize a definition. We use web_search to pull
  // context the URLs reference, since direct fetch of these sites is unreliable.
  const sources = [
    stravaUrl ? `Strava: ${stravaUrl}` : null,
    alltrailsUrl ? `AllTrails: ${alltrailsUrl}` : null,
    description ? `User description: ${description}` : null,
  ].filter(Boolean).join('\n');

  const system = `You build structured trail/peak route definitions for a Colorado conditions bot.
Given a route name and any of: a Strava link, an AllTrails link, a user description — produce a definition that lets another agent tell THIS route apart from the standard out-and-back on the same peak.

Use web_search to research the route name + any place names if the links aren't directly readable. Focus on what makes this route DISTINCT: total distance/gain, whether it's a loop/traverse/ridge/linkup, the specific connectors/segments/off-trail terrain, and which aspects hold snow or add hazard versus the standard route.

Respond with JSON ONLY, no markdown fence:
{
  "canonical_name": "e.g. Mount Yale 360",
  "aliases": ["yale 360","yale loop"],
  "peak": "Mount Yale",
  "route_type": "loop|traverse|ridge|out-and-back|linkup|couloir",
  "distance_km": number or null,
  "gain_m": number or null,
  "key_terrain": "the specific segments/junctions/off-trail bits that define it",
  "aspects": "aspects that hold snow or matter for conditions",
  "distinct_from_standard": "why standard-route conditions do NOT transfer to this route"
}`;

  const userMsg = `Route name: ${name}\n${sources || '(no links or description provided — infer from the name and research)'}`;

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
    messages: [{ role: 'user', content: userMsg }],
  });

  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Could not parse route definition');
  const def = JSON.parse(jsonMatch[0]);

  // Determine source label
  let source = 'user';
  if (stravaUrl) source = `strava:${stravaUrl}`;
  else if (alltrailsUrl) source = `alltrails:${alltrailsUrl}`;

  return { ...def, source };
}
