# Sendable Bot 🏔️

A Discord bot for trail-running communities that answers **"is it sendable?"** for Colorado peaks, passes, and trails — and **gets smarter over time** from your community's feedback.

It runs the same multi-source conditions workflow we built as the `co-mountain-beta` skill (SNOTEL snowpack, 14ers.com trip reports, AllTrails reviews, at-elevation weather forecast, CDOT), wrapped behind a `/sendable` slash command, with a 👍/👎 + "report actual conditions" feedback loop that auto-tunes the model.

---

## What it does

```
/sendable route:"Quandary Peak" date:"this Saturday"
```

→ posts an embed:

```
✅ Quandary Peak — SENDABLE
[2-3 sentence verdict]
❄️ Snowpack:  …
📋 Trip reports:  …
🥾 AllTrails:  …
🌤️ Weather (Sat):  … + turnaround time
📅 Day pick:  …
🔗 Sources: [1][2][3]
Confidence 78% · 👍 0 👎 0 · react to train me
[👍] [👎] [Report actual conditions]
```

---

## The self-healing loop

Three signals feed back into the model, in increasing order of strength:

1. **👍 / 👎 votes** — gently nudge `source_weights` (how much to trust SNOTEL vs 14ers vs AllTrails vs weather). A downvoted call slightly distrusts the sources that drove it; an upvoted call reinforces them.

2. **"Report actual conditions" modal** — the strongest signal. A user who actually went says what it *really* was (sendable / marginal / not yet) + notes. This moves a **per-route bias** term: if the bot over-promised on a route that holds snow late (think Kit Carson Avenue), that route gets a learned conservative bias so future calls account for it.

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
3. **Variables**: add `DISCORD_TOKEN`, `CLIENT_ID`, `ANTHROPIC_API_KEY`, and `DATABASE_PATH=/data/sendable.db`.
4. **Volume**: add a volume mounted at `/data` so the learned model + feedback survive redeploys. *(Without this, the bot still works but forgets what it learned on every deploy.)*
5. After first deploy, run the command registration once. Either:
   - locally: `CLIENT_ID=… DISCORD_TOKEN=… npm run register`, or
   - add a one-off Railway "deploy command" of `npm run register && npm start` for the first boot, then revert to `npm start`.

Railway auto-builds via Nixpacks (`railway.json`). The bot is a long-running process (not a web service), so no port binding is needed.

---

## Files

| File | Role |
|---|---|
| `src/index.js` | Discord bot: `/sendable`, buttons, modal, schedules tuner |
| `src/beta-engine.js` | Calls Claude w/ web_search; injects learned weights/thresholds/bias; returns structured verdict |
| `src/tuner.js` | The self-healing loop: feedback → weight/threshold/bias updates |
| `src/db.js` | SQLite schema + accessors |
| `src/register-commands.js` | One-time slash command registration |

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
