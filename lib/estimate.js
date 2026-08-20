'use strict';
// ESTIMATED RUN TIME.
//
// Rates are MEASURED from the record and recomputed on every call, so the
// estimate improves as the box does more work. Nothing here is a constant
// anyone has to remember.
//
// WHAT DRIVES THE TIME [MEASURED 2026-08-20 across 23 finished runs]:
//   encode  85.3%   verify 9.2%   upload 3.6%   fetch 1.9%
//   Per-film timings account for run elapsed almost exactly - run 7, sixteen
//   films over 13.7 h, had 30 SECONDS unaccounted for. There is no meaningful
//   per-film or per-run overhead to model.
//
// ⛔ THE LADDER IS ONE PASS, NOT SIX. Source is decoded once and written to
// every rung simultaneously (single_decode in the preset), so a six-rung
// ladder costs the same as a one-rung ladder. Charging per rung over-predicts
// by a factor of six.
//
// ⛔ RATES COME FROM TOTALS, NOT FROM AVERAGING PER-FILM RATES. Averaging the
// rate under-predicted by 30-50% because slow films drag the total more than
// fast films lift it. Sum the durations, sum the times, divide.
//
// ACCURACY [MEASURED, pre-registered test against 12 finished runs]: mean
// absolute error 26%, scattered both directions. Substantial runs land within
// ~20%. Short runs with heavy skipping over-predict, because the estimate
// cannot know in advance what already exists at its destination.
// SHOW A RANGE, NEVER A SINGLE FIGURE.
//
// ⚠ SAMPLE CAVEAT: the h264-only rate rests on 10 films from early shakedown
// runs on settings that have since changed, and reads SLOWER than the
// h264+hevc rate, which is a selection effect rather than a finding. It will
// correct itself as backlog runs accumulate.

const { DatabaseSync } = require('node:sqlite');
const DB = '/var/lib/sdvp-encoder/record.db';

// Source masters measure 10.32-10.43 Mbps across 61 films, so duration derived
// from bytes is good to about 1% on this material. Used only when a film has
// never been probed - anything in the record carries its real duration.
const NOMINAL_MBPS = 10.35;

const FALLBACK = { h264: 2.16, both: 1.90, verify: 0.108, fetch_mbps: 74, upload_mbps: 53 };

function rates() {
  let db = null;
  try {
    db = new DatabaseSync(DB, { readOnly: true });
    const one = (s) => { try { return db.prepare(s).get(); } catch (e) { return null; } };
    const h = one(
      "SELECT SUM(m.duration_s) dur, SUM(m.encode_s) enc, COUNT(*) n FROM movies m " +
      "WHERE m.encode_s>0 AND m.duration_s>0 " +
      "AND EXISTS(SELECT 1 FROM rungs r WHERE r.item_id=m.item_id AND r.codec='h264' AND r.state IN ('STORED','VERIFIED')) " +
      "AND NOT EXISTS(SELECT 1 FROM rungs r WHERE r.item_id=m.item_id AND r.codec='hevc' AND r.state IN ('STORED','VERIFIED'))");
    const b = one(
      "SELECT SUM(m.duration_s) dur, SUM(m.encode_s) enc, COUNT(*) n FROM movies m " +
      "WHERE m.encode_s>0 AND m.duration_s>0 " +
      "AND EXISTS(SELECT 1 FROM rungs r WHERE r.item_id=m.item_id AND r.codec='h264' AND r.state IN ('STORED','VERIFIED')) " +
      "AND EXISTS(SELECT 1 FROM rungs r WHERE r.item_id=m.item_id AND r.codec='hevc' AND r.state IN ('STORED','VERIFIED'))");
    const v = one('SELECT SUM(verify_s) v, SUM(encode_s) e FROM movies WHERE encode_s>0');
    const f = one('SELECT SUM(fetch_s) f, SUM(source_bytes) b FROM movies WHERE fetch_s>1');
    const u = one("SELECT SUM(d.upload_s) u, SUM(r.bytes) b FROM deliveries d " +
                  "JOIN rungs r ON r.rung_id=d.rung_id WHERE d.upload_s>1 AND d.destination='pcloud'");
    const ok = (x, a, bb) => (x && x[a] > 0 && x[bb] > 0);
    const out = {
      h264:        ok(h, 'dur', 'enc') ? h.dur / h.enc : FALLBACK.h264,
      both:        ok(b, 'dur', 'enc') ? b.dur / b.enc : FALLBACK.both,
      verify:      ok(v, 'v', 'e')     ? v.v / v.e     : FALLBACK.verify,
      fetch_mbps:  ok(f, 'b', 'f')     ? f.b / 1e6 / f.f : FALLBACK.fetch_mbps,
      upload_mbps: ok(u, 'b', 'u')     ? u.b / 1e6 / u.u : FALLBACK.upload_mbps,
      n_h264: (h && h.n) || 0, n_both: (b && b.n) || 0
    };
    db.close();
    return out;
  } catch (e) {
    try { if (db) db.close(); } catch (e2) {}
    return Object.assign({ n_h264: 0, n_both: 0 }, FALLBACK);
  }
}

// films: [{ duration_s?, bytes, codecs:['h264'] or ['h264','hevc'], out_bytes? }]
// Returns seconds, plus the range to display.
function estimate(films, R) {
  R = R || rates();
  let total = 0;
  for (const f of films || []) {
    const dur = (f.duration_s && f.duration_s > 0)
      ? f.duration_s
      : ((f.bytes || 0) * 8) / (NOMINAL_MBPS * 1e6);
    if (!dur) continue;
    const both = (f.codecs || []).indexOf('hevc') !== -1 && (f.codecs || []).indexOf('h264') !== -1;
    const rate = both ? R.both : R.h264;
    const enc = dur / (rate || FALLBACK.h264);
    // Outputs are smaller than the source; measured across the ladder they
    // come to roughly half the master. Used only when the caller cannot know.
    const ob = (f.out_bytes != null) ? f.out_bytes : (f.bytes || 0) * 0.5;
    total += enc * (1 + R.verify)
           + ((f.bytes || 0) / 1e6) / (R.fetch_mbps || FALLBACK.fetch_mbps)
           + (ob / 1e6) / (R.upload_mbps || FALLBACK.upload_mbps);
  }
  return { seconds: total, low: total * 0.8, high: total * 1.25, rates: R };
}

function words(sec) {
  if (!sec || sec <= 0) return '—';
  const h = sec / 3600;
  if (h < 1) return Math.round(sec / 60) + ' min';
  if (h < 10) return h.toFixed(1) + ' h';
  return Math.round(h) + ' h';
}
function range(e) { return words(e.low) + ' to ' + words(e.high); }

module.exports = { rates, estimate, words, range, NOMINAL_MBPS };
