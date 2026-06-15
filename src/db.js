// src/db.js
// SQLite persistence for the self-healing feedback loop.
// Stores: query history, user feedback (thumbs), structured corrections,
// learned source weights, and learned verdict thresholds.

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Railway provides a persistent volume mount; default to local file otherwise.
const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'sendable.db');

// better-sqlite3 will not create missing parent directories, so ensure the
// directory exists before opening (matters on first boot with a fresh volume).
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

export function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS queries (
      id TEXT PRIMARY KEY,
      route_name TEXT NOT NULL,
      target_date TEXT,
      discord_user_id TEXT NOT NULL,
      discord_channel_id TEXT,
      verdict TEXT,              -- SENDABLE / MARGINAL / NOT_YET
      confidence REAL,
      summary TEXT,
      raw_sources TEXT,          -- JSON blob of what each source returned
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_id TEXT NOT NULL,
      discord_user_id TEXT NOT NULL,
      vote INTEGER NOT NULL,     -- +1 thumbs up, -1 thumbs down
      created_at INTEGER NOT NULL,
      UNIQUE(query_id, discord_user_id) ON CONFLICT REPLACE,
      FOREIGN KEY (query_id) REFERENCES queries(id)
    );

    -- Free-text or structured corrections, e.g. "actually postholed to my waist, NOT sendable"
    CREATE TABLE IF NOT EXISTS corrections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_id TEXT NOT NULL,
      route_name TEXT NOT NULL,
      discord_user_id TEXT NOT NULL,
      corrected_verdict TEXT,    -- what it should have been
      note TEXT,                 -- the user's words
      ground_truth_date TEXT,    -- when they actually went
      created_at INTEGER NOT NULL,
      processed INTEGER DEFAULT 0,  -- has the tuner ingested this yet
      FOREIGN KEY (query_id) REFERENCES queries(id)
    );

    -- Learned multiplicative weight per source. Starts at 1.0, nudged by feedback.
    CREATE TABLE IF NOT EXISTS source_weights (
      source TEXT PRIMARY KEY,   -- 'snotel','14ers','alltrails','strava','weather'
      weight REAL NOT NULL DEFAULT 1.0,
      sample_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER
    );

    -- Learned verdict thresholds, tunable per-activity-type.
    CREATE TABLE IF NOT EXISTS verdict_thresholds (
      activity_type TEXT PRIMARY KEY,  -- 'run','ride','peak'
      sendable_max_snow_in REAL NOT NULL,
      marginal_max_snow_in REAL NOT NULL,
      updated_at INTEGER
    );

    -- Per-route learned offset: some routes hold snow longer than the model expects.
    -- Positive bias = route is consistently MORE snowy/dangerous than predicted.
    CREATE TABLE IF NOT EXISTS route_bias (
      route_name TEXT PRIMARY KEY,
      bias REAL NOT NULL DEFAULT 0.0,  -- -1..+1, shifts verdict conservatism
      sample_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER
    );

    -- Stored route definitions so the bot knows WHICH route on a peak is meant,
    -- not just the nearby standard out-and-back. Built from Strava/AllTrails/user input.
    CREATE TABLE IF NOT EXISTS routes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_name TEXT NOT NULL,          -- "Mount Yale 360"
      aliases TEXT,                           -- JSON array of lowercased alt names
      peak TEXT,                              -- "Mount Yale" (the underlying summit/area)
      route_type TEXT,                        -- 'loop','traverse','ridge','out-and-back','linkup','couloir'
      distance_km REAL,
      gain_m REAL,
      key_terrain TEXT,                       -- what distinguishes it: segments, junctions, off-trail bits
      aspects TEXT,                           -- e.g. "north-facing CT section, exposed W ridge"
      distinct_from_standard TEXT,            -- why standard-route beta does NOT transfer
      source TEXT,                            -- 'strava:1234','alltrails:url','user'
      created_by TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_routes_name ON routes(canonical_name);
  `);

  // Seed defaults if empty
  const seedSources = db.prepare(
    `INSERT OR IGNORE INTO source_weights (source, weight, updated_at) VALUES (?, 1.0, ?)`
  );
  const now = Date.now();
  for (const s of ['snotel', '14ers', 'alltrails', 'strava', 'weather']) {
    seedSources.run(s, now);
  }

  const seedThresh = db.prepare(
    `INSERT OR IGNORE INTO verdict_thresholds
     (activity_type, sendable_max_snow_in, marginal_max_snow_in, updated_at)
     VALUES (?, ?, ?, ?)`
  );
  // Defaults derived from the co-mountain-beta skill
  seedThresh.run('run', 6, 18, now);
  seedThresh.run('ride', 4, 14, now);
  seedThresh.run('peak', 3, 12, now);

  console.log('Migration complete:', DB_PATH);
}

// ---- Query/feedback helpers ----

export function saveQuery(q) {
  db.prepare(`
    INSERT INTO queries (id, route_name, target_date, discord_user_id, discord_channel_id,
      verdict, confidence, summary, raw_sources, created_at)
    VALUES (@id, @route_name, @target_date, @discord_user_id, @discord_channel_id,
      @verdict, @confidence, @summary, @raw_sources, @created_at)
  `).run(q);
}

export function recordVote(queryId, userId, vote) {
  db.prepare(`
    INSERT INTO feedback (query_id, discord_user_id, vote, created_at)
    VALUES (?, ?, ?, ?)
  `).run(queryId, userId, vote, Date.now());
}

export function getQuery(queryId) {
  return db.prepare(`SELECT * FROM queries WHERE id = ?`).get(queryId);
}

export function getVoteTally(queryId) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN vote > 0 THEN 1 ELSE 0 END), 0) AS up,
      COALESCE(SUM(CASE WHEN vote < 0 THEN 1 ELSE 0 END), 0) AS down
    FROM feedback WHERE query_id = ?
  `).get(queryId);
  return { up: row.up, down: row.down };
}

export function saveCorrection(c) {
  db.prepare(`
    INSERT INTO corrections (query_id, route_name, discord_user_id,
      corrected_verdict, note, ground_truth_date, created_at)
    VALUES (@query_id, @route_name, @discord_user_id,
      @corrected_verdict, @note, @ground_truth_date, @created_at)
  `).run(c);
}

// ---- Learned-parameter accessors ----

export function getSourceWeights() {
  const rows = db.prepare(`SELECT source, weight FROM source_weights`).all();
  return Object.fromEntries(rows.map(r => [r.source, r.weight]));
}

export function getThresholds(activityType) {
  return db.prepare(
    `SELECT * FROM verdict_thresholds WHERE activity_type = ?`
  ).get(activityType) || db.prepare(
    `SELECT * FROM verdict_thresholds WHERE activity_type = 'peak'`
  ).get();
}

export function getRouteBias(routeName) {
  const row = db.prepare(
    `SELECT bias FROM route_bias WHERE route_name = ?`
  ).get(normalizeRoute(routeName));
  return row ? row.bias : 0;
}

// ---- Route definition helpers ----

export function saveRoute(r) {
  return db.prepare(`
    INSERT INTO routes (canonical_name, aliases, peak, route_type, distance_km, gain_m,
      key_terrain, aspects, distinct_from_standard, source, created_by, created_at)
    VALUES (@canonical_name, @aliases, @peak, @route_type, @distance_km, @gain_m,
      @key_terrain, @aspects, @distinct_from_standard, @source, @created_by, @created_at)
  `).run(r);
}

// Find a stored route by fuzzy-matching the query against canonical names + aliases.
export function findRoute(query) {
  const q = normalizeRoute(query);
  const all = db.prepare(`SELECT * FROM routes`).all();
  let best = null;
  let bestScore = 0;
  for (const r of all) {
    const names = [r.canonical_name, ...(safeParse(r.aliases) || [])].map(normalizeRoute);
    for (const name of names) {
      const score = matchScore(q, name);
      if (score > bestScore) { bestScore = score; best = r; }
    }
  }
  // Require a reasonably strong match to avoid false positives.
  return bestScore >= 0.6 ? best : null;
}

export function listRoutes() {
  return db.prepare(`SELECT canonical_name, peak, route_type, distance_km FROM routes ORDER BY canonical_name`).all();
}

// Simple token-overlap score (0..1). "yale 360" vs "mount yale 360" -> high.
function matchScore(a, b) {
  const ta = new Set(a.split(' ').filter(Boolean));
  const tb = new Set(b.split(' ').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  // Bias toward covering the query's tokens (so "yale 360" must see both "yale" and "360").
  return inter / ta.size;
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

export function normalizeRoute(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export { db };

// Allow `node src/db.js --migrate`
if (process.argv.includes('--migrate')) migrate();
