// src/tuner.js
// The "self-healing" loop. Runs periodically (and on each new correction).
// Converts user feedback (thumbs) + structured corrections into nudges on:
//   1. source_weights  — which sources to trust
//   2. verdict_thresholds — when to call SENDABLE
//   3. route_bias — per-route conservatism
//
// Philosophy: small, bounded, reversible nudges. Never let one angry downvote
// swing the model hard. Use EMA-style updates with a learning rate and clamps.

import { db, normalizeRoute } from './db.js';

const LR = 0.05;            // learning rate for weights
const WEIGHT_MIN = 0.4;
const WEIGHT_MAX = 1.8;
const BIAS_LR = 0.10;
const BIAS_MIN = -1.0;
const BIAS_MAX = 1.0;
const THRESH_LR = 0.5;     // inches per correction, clamped

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

// Net sentiment for a query: + means users agreed, - means they disagreed.
function querySentiment(queryId) {
  const row = db.prepare(`
    SELECT COALESCE(SUM(vote),0) AS net, COUNT(*) AS n FROM feedback WHERE query_id = ?
  `).get(queryId);
  return { net: row.net, n: row.n };
}

// Adjust source weights: if a verdict got downvoted, gently distrust the sources
// that most strongly drove it; if upvoted, reinforce them. We approximate "drove it"
// by which sources were present in the raw_sources blob.
function tuneSourceWeights(query, sentiment) {
  if (sentiment.n === 0) return;
  let raw = {};
  try { raw = JSON.parse(query.raw_sources || '{}'); } catch { /* ignore */ }
  const present = Object.keys(raw).filter(k => raw[k]);
  if (present.length === 0) return;

  const direction = Math.sign(sentiment.net); // +1 reinforce, -1 distrust
  const magnitude = Math.min(Math.abs(sentiment.net), 5) / 5; // saturate

  const upd = db.prepare(`
    UPDATE source_weights
    SET weight = ?, sample_count = sample_count + 1, updated_at = ?
    WHERE source = ?
  `);
  const get = db.prepare(`SELECT weight FROM source_weights WHERE source = ?`);

  for (const src of present) {
    const cur = get.get(src);
    if (!cur) continue;
    const next = clamp(cur.weight + direction * magnitude * LR, WEIGHT_MIN, WEIGHT_MAX);
    upd.run(next, Date.now(), src);
  }
}

// Apply a structured correction: someone told us the real verdict.
// This is the strongest signal — it moves route_bias and possibly thresholds.
function applyCorrection(corr) {
  const predicted = (corr.predicted_verdict || '').toUpperCase();
  const actual = (corr.corrected_verdict || '').toUpperCase();
  if (!actual) return;

  const order = { SENDABLE: 2, MARGINAL: 1, NOT_YET: 0 };
  const pv = order[predicted];
  const av = order[actual];

  // If we said it was MORE sendable than reality -> route holds snow longer -> +bias (more conservative)
  // If we said LESS sendable than reality -> melts faster -> -bias
  if (pv !== undefined && av !== undefined && pv !== av) {
    const delta = Math.sign(pv - av) * BIAS_LR; // pv>av means we over-promised -> positive bias
    const rn = normalizeRoute(corr.route_name);
    const row = db.prepare(`SELECT bias, sample_count FROM route_bias WHERE route_name = ?`).get(rn);
    if (row) {
      const next = clamp(row.bias + delta, BIAS_MIN, BIAS_MAX);
      db.prepare(`UPDATE route_bias SET bias = ?, sample_count = sample_count + 1, updated_at = ? WHERE route_name = ?`)
        .run(next, Date.now(), rn);
    } else {
      db.prepare(`INSERT INTO route_bias (route_name, bias, sample_count, updated_at) VALUES (?, ?, 1, ?)`)
        .run(rn, clamp(delta, BIAS_MIN, BIAS_MAX), Date.now());
    }

    // If we systematically over-promise on RUNS, tighten the run threshold a touch.
    // (Heuristic: only when we said SENDABLE but reality was NOT_YET.)
    if (predicted === 'SENDABLE' && actual === 'NOT_YET') {
      const t = db.prepare(`SELECT * FROM verdict_thresholds WHERE activity_type = 'run'`).get();
      if (t) {
        const newSendable = clamp(t.sendable_max_snow_in - THRESH_LR, 1, t.marginal_max_snow_in - 1);
        db.prepare(`UPDATE verdict_thresholds SET sendable_max_snow_in = ?, updated_at = ? WHERE activity_type = 'run'`)
          .run(newSendable, Date.now());
      }
    }
  }
}

export function runTuner() {
  // 1. Process unprocessed corrections (strongest signal first)
  const corrections = db.prepare(`
    SELECT c.*, q.verdict AS predicted_verdict
    FROM corrections c JOIN queries q ON q.id = c.query_id
    WHERE c.processed = 0
  `).all();

  const markProcessed = db.prepare(`UPDATE corrections SET processed = 1 WHERE id = ?`);
  for (const corr of corrections) {
    applyCorrection(corr);
    markProcessed.run(corr.id);
  }

  // 2. Process thumbs sentiment on recent queries (last 30 days)
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  const recent = db.prepare(`SELECT * FROM queries WHERE created_at > ?`).all(cutoff);
  for (const q of recent) {
    const sentiment = querySentiment(q.id);
    tuneSourceWeights(q, sentiment);
  }

  return {
    corrections_processed: corrections.length,
    queries_reviewed: recent.length,
  };
}

// Allow manual trigger: `node src/tuner.js`
if (process.argv[1] && process.argv[1].endsWith('tuner.js')) {
  console.log(runTuner());
}
