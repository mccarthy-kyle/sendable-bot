# Sendable Bot 🏔️

A Discord bot for trail-running communities that answers **"is it sendable?"** for Colorado peaks, passes, and trails — and **gets smarter over time** from your community's feedback.

## ⚠️ Safety — read this before letting anyone rely on it

**This bot is not a safety system and its verdicts are not clearance to go.** It reads incomplete public web data through an LLM and *will sometimes be wrong* — it can miss a recent storm, misread a report, or hallucinate. Built-in guardrails (calibrated verdicts, mandatory hazard callouts, data-age disclosure, a narrow safety net that downgrades only no-data/very-low-confidence SENDABLE calls, and a "not a safety call — check CAIC" line on every result) reduce but **do not eliminate** that risk.

Make sure your community understands:
- A green **SENDABLE** means *conditions appear favorable per available data* — not that it's safe, and not a go-ahead.
- It is **not an avalanche forecast**. For any snow travel, check [CAIC](https://avalanche.state.co.us).
- Recent on-route reports, the current forecast, and personal judgment always override the bot.
- The person clicking "go" owns that decision, fully.

If that framing isn't acceptable for your group, don't deploy it.

It runs a multi-source conditions workflow (SNOTEL snowpack, 14ers.com trip reports, AllTrails reviews, at-elevation weather forecast, CDOT) wrapped behind a `/sendable` slash command, with a 👍/👎 + "report actual conditions" feedback loop that tunes its behavior over time.

---

## How it works behind the scenes

When someone runs `/sendable route:"Mount Princeton" date:"this Saturday"`, here's the full pipeline:

**1. Route resolution (`beta-engine.js` + `db.js`).**
The bot first tries to figure out *which* route is meant — not just which peak.
- It fuzzy-matches the query against stored routes (`findRoute` in `db.js`): your `/defineroute` entries, the curated Strava routes, and the COTREX trail catalog. Matching ranks by name overlap, then prefers enriched/user-defined routes over raw imported trails, then higher-elevation/alpine-region routes — so "Princeton" finds the 14er, not a same-named city path.
- It detects **route variants**: if the query contains `360`, `loop`, `traverse`, `ridge`, `couloir`, `linkup`, etc., it knows the standard out-and-back conditions don't apply and adjusts the prompt accordingly.
- If nothing matches and the name is unfamiliar, it does **not** give up — it's instructed to run Colorado-specific searches and decode descriptive nicknames (e.g. "infinity loop" = the Elbert–Massive figure-eight) before, as a last resort, asking one short clarifying question.

**2. Building the prompt.**
The engine assembles a system prompt that injects: the resolved route context, learned source-reliability weights, learned verdict thresholds, any per-route learned bias, a dated seasonal baseline (e.g. "2026 is a low snow year"), and any **community field reports** previously submitted for this route via the correction modal. This is what makes two people asking about the same route get answers informed by what the crew has actually reported.

**3. Live research via Claude + web search.**
The prompt goes to the Claude API (`claude-sonnet-4-6` by default) with the **web search tool** enabled (up to 12 searches). Claude runs the workflow itself — searching SNOTEL, 14ers.com trip reports, AllTrails snippets, NWS/mountain-forecast at summit elevation, and CDOT — then weighs what it finds.

**4. Reasoning rules baked into the prompt.**
The engine enforces how evidence is weighed:
- **Dated trip reports beat generic boilerplate.** A specific "May 16: dry, didn't use traction" report overrides an undated "early season may require spikes" seasonal blurb. The bot won't hedge a dry route down because of catch-all warnings, and won't invent hazards no recent report mentions.
- **Calibrated, not timid.** Good recent evidence → SENDABLE, stated plainly. Caution is reserved for genuinely thin/conflicting data or real hazards.
- **Common-sense fallback, never fabrication.** If a live source (e.g. SNOTEL) fails, it reasons from known context (the seasonal baseline, recent reports) and says so — it never invents numbers, and never asserts anything that contradicts data already in hand.
- **Route-match tagging.** Every report it uses is tagged ON_ROUTE / PARTIAL / WRONG_ROUTE; a "perfect conditions" report for the wrong route can't drive the verdict.

**5. Structured verdict back.**
Claude returns a JSON object: a four-tier verdict (`SENDABLE` / `LIKELY` / `MARGINAL` / `NOT_YET`), a confidence score, a one-line TL;DR, data-age, named hazards, and the per-source findings. The engine parses the last text block (robust to interim tool-use commentary) and falls back to a graceful MARGINAL if the response is malformed rather than crashing.

**6. Display + safety net (`index.js`).**
The bot renders a compact Discord embed: TL;DR headline, the verdict with color/emoji, side-by-side snow/weather, recent reports, hazards, a day pick, and a one-line "not a safety call — check CAIC" footer. A light code-level net only downgrades a SENDABLE if the model itself reported *no real data* **and** was very unconfident — a confident SENDABLE on good data always stands.

**7. Feedback → tuning (`tuner.js`).**
The 👍/👎 buttons and the "report actual conditions" modal feed the self-healing loop (next section), which adjusts source weights, verdict thresholds, and per-route bias over time.

### Architecture at a glance

```
Discord /sendable
      │
      ▼
 index.js ──── resolves route ──► db.js (routes/peaks, learned params, field notes)
      │
      ▼
 beta-engine.js ─ builds prompt (route ctx + learned weights + baseline + field notes)
      │
      ▼
 Claude API + web_search ─ SNOTEL · 14ers · AllTrails · weather · CDOT
      │
      ▼
 structured JSON verdict ──► compact Discord embed (TL;DR + 4-tier rating)
      │
      ▼
 👍/👎 + "report conditions" ──► tuner.js ──► updates learned params in db.js
```

---

## Commands

```
/sendable route:"Quandary Peak" date:"this Saturday"
```
→ posts a conditions embed (below).

```
/defineroute name:"Yale 360" strava:<url> alltrails:<url> description:"30km loop, not the standard out-and-back"
```
→ teaches the bot a specific route so it stops confusing it with the standard route on the same peak. All args except `name` are optional; the bot researches and stores the distinguishing terrain, then matches future `/sendable` queries against it.

```
/routes
```
→ lists the custom routes the bot has learned.

### The `/sendable` embed

```
✅ Mount Princeton — SENDABLE
TL;DR — Dry and runnable now; standard East Slopes is in summer shape.
❄️ Snow / pack:  …          🌤️ Weather (Sat):  … + turnaround
📋 Recent reports:  May 16 "dry, didn't use traction" (ON_ROUTE)
⚠️ Watch for:  afternoon storms above treeline
📅 Day pick:  …
🔗 Sources: [1][2][3]
78% confidence · most recent report 9 days ago · not a safety call — check CAIC · 👍0 👎0
[👍] [👎] [Report actual conditions]
```

The verdict uses a **four-tier scale**: ✅ SENDABLE (recent evidence shows good conditions) · 🟢 LIKELY GOOD (looks good, evidence slightly less direct/fresh) · ⚠️ MARGINAL (genuinely mixed) · ❌ NOT YET (clear signs it's not in). A bold **TL;DR** leads every card; fuller detail collapses into a "📖 More" field only when there's more to say.

### Route precision

The bot distinguishes *which* route on a peak you mean. A query with a qualifier like `360`, `loop`, `traverse`, `ridge`, `couloir`, or `linkup` (or any route saved via `/defineroute`) will not be answered with standard out-and-back conditions. Reports are tagged ON_ROUTE / PARTIAL / WRONG_ROUTE, and a "perfect conditions" report for the wrong route is demoted to labeled proxy data rather than driving the verdict. When only standard-route data exists, the embed says so and infers for the actual route.

**Identifying unknown routes.** If a route isn't in the database, the bot does NOT dead-end. It runs Colorado-specific searches (appends "Colorado", tries FKT/14ers/figure-eight/linkup phrasings) and reasons about descriptive nicknames — e.g. "infinity loop" = the Elbert–Massive figure-eight, "the tour"/"traverse"/"horseshoe" = linkups. Only if still unresolved after real searching does it ask one short locating question, never a wall of disclaimers.

---

## The self-healing loop

Three signals feed back into the model, in increasing order of strength:

1. **👍 / 👎 votes** — gently nudge `source_weights` (how much to trust SNOTEL vs 14ers vs AllTrails vs weather). A downvoted call slightly distrusts the sources that drove it; an upvoted call reinforces them.

2. **"Report actual conditions" modal** — the strongest signal. A user who actually went says what it *really* was (sendable / marginal / not yet), when, and a free-form note of what they found. This does two things: (a) moves a **per-route bias** term so a route that holds snow late (think Kit Carson Avenue) gets a learned conservative adjustment, and (b) the free-form note is **stored and injected directly into the prompt** the next time anyone asks about that route — labeled as high-value, on-the-ground ground truth weighted above generic web sources. So if someone writes "creek at mile 4 was thigh-deep," the next person asking sees that reflected.

3. **Systematic over-promising** (e.g. repeatedly saying SENDABLE when reality was NOT_YET on runs) nudges the global **verdict thresholds** tighter.

All updates are **bounded and reversible** — small learning rates, hard clamps (`tuner.js`), so one grumpy downvote can't swing the model. The tuner runs every 6 hours and immediately after each correction.

Learned state lives in SQLite (`source_weights`, `verdict_thresholds`, `route_bias`), so it persists and is inspectable.

---

## Setup

### 1. Create the Discord app
- https://discord.com/developers/applications → New Application
- **Bot** tab → Reset Token → copy into `DISCORD_TOKEN`
- **General Information** → copy Application ID into `CLIENT_ID`
- **Installation / OAuth2** → scopes `bot` + `applications.commands`, bot permissions: Send Messages, Embed Links, Use Slash Commands. Invite to your server.

### 2. Configure env
```bash
cp .env.example .env
# fill in DISCORD_TOKEN, CLIENT_ID, ANTHROPIC_API_KEY
# (optional) GUILD_ID = your server ID for instant command registration during dev
```

### 3. Install + register + run
```bash
npm install
npm run register   # registers the /sendable command
npm start
```

---

## Deploy to Railway

1. Push this folder to a GitHub repo.
2. Railway → New Project → Deploy from GitHub repo.
3. **Variables**: add `DISCORD_TOKEN`, `CLIENT_ID`, `ANTHROPIC_API_KEY`, `DATABASE_PATH=/data/sendable.db`, and **`NIXPACKS_NODE_VERSION=20`**. The Node version variable is important — `better-sqlite3` has no prebuilt binary for the newest Node and will fail the build trying to compile from source (missing Python). Pinning Node 20 avoids this.
4. **Volume**: add a volume mounted at `/data` so the learned model + feedback survive redeploys. *(Without this, the bot still works but forgets what it learned on every deploy.)*
5. After first deploy, run the command registration once. Either:
   - locally: `CLIENT_ID=… DISCORD_TOKEN=… npm run register`, or
   - add a one-off Railway "deploy command" of `npm run register && npm start` for the first boot, then revert to `npm start`.

Railway auto-builds via Nixpacks (`railway.json`). The bot is a long-running process (not a web service), so no port binding is needed.

---

## Bulk-loading routes from COTREX

The bot can seed its route library from **COTREX** (Colorado Trail Explorer), the state's official open-data trail layer — no scraping, no login, ~40,000 miles of mapped trails.

```bash
npm run seed:cotrex                       # whole state (~40k trails, noisy)
npm run seed:cotrex -- --region=sawatch   # one alpine range (recommended)
npm run seed:cotrex -- --regions=sawatch,sangre,san_juan,elk,mosquito,front
```

This pulls maintained Colorado trails with reliable metadata (name, length, use type/manager) into the `routes` table, marked `source: cotrex` and tagged with their region. Re-runnable — skips trails already stored.

**Region filtering (recommended).** Statewide pulls ~40k trails including every urban greenway. Passing `--region` or `--regions` filters server-side via an ArcGIS spatial bounding-box query (the range boxes in `co-regions.js`), so you only pull trails in the alpine ranges you care about. For your use, `--regions=sawatch,sangre,san_juan,elk,mosquito,front` gives the alpine backbone without the city-path noise.

**What COTREX is good for:** the maintained, named-trail backbone (CT segments, approach trails). **What it doesn't contain:** off-trail peak linkups or informal route names (e.g. "Yale 360", "Nolan's") — those come from `/defineroute`.

To point at a different COTREX mirror if the endpoint changes, set `COTREX_URL` to a `.../FeatureServer/<id>` layer.

### Belt-and-suspenders: query-time filtering too

Even with region filtering at import, `findRoute` also ranks at match time: name match first, then enriched/user routes over raw COTREX rows, then higher elevation and alpine regions. So a query won't get hijacked by a same-named city path, and `/routes` lists enriched routes before raw COTREX trails.

## Seeding your own routes (Strava + curated JSON)

`seeds/strava-routes.json` holds routes curated from your Strava run/hike history (Yale, Shavano, Browns Creek, Salida, Collegiate, Sangre series). Load it with:

```bash
npm run seed:json seeds/strava-routes.json
```

This is a generic JSON importer — any file that's an array of route objects (`canonical_name`, `aliases`, `peak`, `region`, `distance_km`, etc.) works. Re-runnable, dedupes by name. To add more routes, append to the JSON file and re-run.

**Note on Strava:** the MCP exposes activities, not saved routes, and your activity *names* are often personal ("string bean boys") rather than route names — so the seed is hand-curated down to the entries with real geography. AllTrails Pro does not expose an API, so AllTrails routes come in one at a time via `/defineroute` with a URL.

---

## Bulk-loading peaks from USGS GNIS

```bash
# download DomesticNames_Colorado.txt from the USGS National Map, drop in seeds/, then:
npm run seed:gnis seeds/DomesticNames_Colorado.txt
# or, where outbound network is allowed:
npm run seed:gnis -- --url=<direct-txt-url>
```

Imports Colorado **summits** from USGS GNIS — the official federal geographic-names database. It's **public domain** (U.S. Government work), purpose-built as a gazetteer, with no ToS restrictions. Filters to feature class `Summit`, keeps peaks above ~11,500 ft (`GNIS_MIN_ELEV_M`, default 3500m), tags each by mountain region from its coordinates, and dedupes by name. Gives you name + coordinates + elevation for every named Colorado summit.

The Colorado file is `DomesticNames_Colorado.txt` (pipe-delimited) from The National Map Staged Products Directory → Geographic Names folder. GNIS doesn't carry prominence, so that field stays null.

> We deliberately use GNIS instead of Peakbagger: Peakbagger's Terms of Service restrict its data to personal, non-commercial use and prohibit compiling/redistributing it, so it's not an appropriate source to seed a shared bot. GNIS is the right, openly-licensed equivalent.

---


|---|---|
| `src/index.js` | Discord bot: `/sendable`, `/defineroute`, `/routes`, buttons, modal, schedules tuner |
| `src/beta-engine.js` | Calls Claude w/ web_search; route-aware; injects weights/thresholds/bias + community field notes; returns structured verdict |
| `src/route-builder.js` | Builds a structured route definition from a Strava/AllTrails link + description (`/defineroute`) |
| `src/tuner.js` | The self-healing loop: feedback → weight/threshold/bias updates |
| `src/db.js` | SQLite schema + accessors (queries, feedback, corrections, routes, learned params) |
| `src/register-commands.js` | One-time slash command registration |
| `src/seed-cotrex.js` | Bulk-imports Colorado trails from the COTREX open-data API into the routes table (re-runnable) |
| `src/seed-gnis.js` | Imports Colorado summits from USGS GNIS (public-domain federal data) into the peaks table |
| `src/co-regions.js` | Colorado mountain-range bounding boxes used for region tagging |
| `src/seed-json.js` | Generic importer for a JSON array of routes (used for the curated Strava seed) |
| `seeds/strava-routes.json` | Curated routes from your Strava run/hike history |

---

## Tuning knobs (in `tuner.js`)

- `LR` (0.05) — source-weight learning rate
- `WEIGHT_MIN/MAX` (0.4–1.8) — clamp so no source is fully ignored or fully trusted
- `BIAS_LR` (0.10) — per-route conservatism learning rate
- `THRESH_LR` (0.5 in) — how much a systematic miss tightens thresholds

Start conservative; raise `LR` if you want faster adaptation once you trust the signal.

---

## Notes & honest limitations

- **Strava leaderboards**: the bot does *not* pull "who's run this segment in 2026" — Strava's API needs per-user OAuth and their public pages block scraping. You can still drop segment leaderboard links manually. (Same limitation we hit building the skill.)
- **AllTrails**: fetched via search snippets only (they block direct scraping).
- **Forecast horizon**: beyond ~7 days the weather call is low-confidence and the bot says so.
- **Not a safety guarantee**: it's crowdsourced beta + model inference. Always carry your own judgment into the alpine.
