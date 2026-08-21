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

// ⛔ RUNGS ARE NOT FREE. [MEASURED 2026-08-21, same film three times on the same
// box within one hour] BRACE CLASS ABTC2026: one rung 24.2 s, two rungs 50.9 s,
// five rungs 85.5 s. A full ladder costs ~3.5x a single rung. The single blended
// rate charged the same for both and under-predicted every multi-rung ladder -
// exactly the overnight backlog runs the figure is used to plan.
//
// THE SHAPE: a fixed cost to decode the source once, plus a cost proportional to
// the PICTURE AREA written. 240p is a tenth of 720p's pixels and costs about a
// tenth. Fitted across 71 films:
//   held-out test, 47 films fitted / 24 never seen: 6.7% mean absolute error,
//   against 38.6% for the single-rate model on the same held-out films.
//
// ⚠ THE HEVC COEFFICIENT IS PROVISIONAL. Nearly all HEVC in the record is
// single-rung 1080p mezzanine, so that term carries whatever else differed about
// those runs rather than measuring the codec - it currently reads HEVC as
// slightly CHEAPER per pixel than H.264, which contradicts the settings. Flagged
// in the response. It corrects itself when mezzanine ladders run.
const PX = { 2160: 3840*2160, 1440: 2560*1440, 1080: 1920*1080, 720: 1280*720,
             540: 960*540, 480: 854*480, 360: 640*360, 240: 426*240 };
const PX_BASE = PX[720];
const MIN_FIT_FILMS = 8;
const MIN_HEVC_FILMS = 6;
// ⛔ AND AT MORE THAN ONE HEIGHT. Dr. K's ruling 2026-08-21: HEVC has only ever
// been run at 1080p on this box, so a coefficient fitted from it describes one
// rung height and is extrapolated to five it has never seen.
//
// ⭐ WHY THE TERM READS LOW, Dr. K's explanation: the masters are already
// encodes of encoded video - recorded compressed, edited, re-encoded, then fed
// to us for a third compression. Generational smoothing removes exactly the
// high-frequency detail that makes encoding expensive, so BOTH codecs run
// cheaper on this material than they would on camera-original footage, and
// HEVC's rate-distortion search may genuinely have less work to do. Plausible,
// unmeasured, and not a reason to trust one height extrapolated to six.
const MIN_HEVC_HEIGHTS = 2;

// ⛔ THE H.264 TOP RUNG IS NOT ENCODED. master_is_top_rung: an H.264 master at
// 1080p means the 1080p H.264 rung is linked, not encoded. [MEASURED, run 30:
// SKIPPED on all 16 films.] It is the largest single term in the ladder - 2.25x
// a 720p rung - so counting it inflates every estimate by about a third.
// HEVC 1080p IS a real encode and is counted.
function pixelLoad(rungs) {
  let h = 0, e = 0;
  for (const r of rungs || []) {
    const px = PX[Number(r.height)];
    if (!px) continue;
    const codec = String(r.codec || 'h264');
    if (codec === 'hevc') e += px / PX_BASE;
    else if (Number(r.height) < 1080) h += px / PX_BASE;
  }
  return { h264: h, hevc: e };
}

// Least squares on enc/dur = A + B*h264_load + C*hevc_load. Gaussian
// elimination on the 3x3 normal equations; returns null rather than a wild
// answer if the system is singular or the sample is too thin.
function solve3(m, v) {
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let k = i; k < 3; k++) if (Math.abs(m[k][i]) > Math.abs(m[p][i])) p = k;
    const tm = m[i]; m[i] = m[p]; m[p] = tm;
    const tv = v[i]; v[i] = v[p]; v[p] = tv;
    if (Math.abs(m[i][i]) < 1e-12) return null;
    for (let k = 0; k < 3; k++) {
      if (k === i) continue;
      const f = m[k][i] / m[i][i];
      for (let j = 0; j < 3; j++) m[k][j] -= f * m[i][j];
      v[k] -= f * v[i];
    }
  }
  return [v[0]/m[0][0], v[1]/m[1][1], v[2]/m[2][2]];
}

function fitEncode(db) {
  let rows;
  try {
    rows = db.prepare(
      "SELECT m.duration_s dur, m.encode_s enc, " +
      "GROUP_CONCAT(r.codec || ':' || r.height) hs " +
      "FROM movies m JOIN rungs r ON r.item_id = m.item_id " +
      "WHERE m.encode_s > 0 AND m.duration_s > 0 " +
      "AND r.state IN ('STORED','VERIFIED') GROUP BY m.item_id").all();
  } catch (e) { return null; }

  const pts = [];
  let nHevc = 0;
  const hevcHeights = {};
  for (const r of rows) {
    const rungs = String(r.hs || '').split(',').map(t => {
      const bits = t.split(':');
      return { codec: bits[0], height: Number(bits[1]) };
    });
    // The fit uses rungs that were ACTUALLY WRITTEN, so a skipped top rung
    // never enters it - which is why the estimate must exclude it too.
    let h = 0, e = 0;
    for (const x of rungs) {
      const px = PX[x.height]; if (!px) continue;
      if (x.codec === 'hevc') { e += px / PX_BASE; hevcHeights[x.height] = 1; }
      else h += px / PX_BASE;
    }
    if (h + e <= 0) continue;
    if (e > 0) nHevc++;
    pts.push({ dur: r.dur, enc: r.enc, h: h, e: e });
  }
  if (pts.length < MIN_FIT_FILMS) return null;

  const m = [[0,0,0],[0,0,0],[0,0,0]], v = [0,0,0];
  for (const r of pts) {
    const x = [1, r.h, r.e], y = r.enc / r.dur;
    for (let i = 0; i < 3; i++) { v[i] += x[i]*y; for (let j = 0; j < 3; j++) m[i][j] += x[i]*x[j]; }
  }
  const c = solve3(m, v);
  if (!c || !isFinite(c[0]) || !isFinite(c[1]) || c[1] <= 0) return null;

  // A negative or absurd HEVC term means the sample cannot support it. Fall
  // back to the H.264 cost rather than publish a coefficient that would price
  // a mezzanine ladder as free.
  const nHeights = Object.keys(hevcHeights).length;
  // FALL BACK WHENEVER THE TERM IS NOT EARNED, not only when it is absurd. An
  // HEVC rung then costs what an H.264 rung of the same size costs, which
  // OVER-predicts a mezzanine ladder rather than under - the safe direction for
  // a figure used to decide whether to load one night or three.
  const hevcOk = (nHevc >= MIN_HEVC_FILMS && nHeights >= MIN_HEVC_HEIGHTS &&
                  isFinite(c[2]) && c[2] > 0);
  let hevc = hevcOk ? c[2] : c[1];
  return { base: Math.max(0, c[0]), h264: c[1], hevc: hevc,
           n: pts.length, n_hevc: nHevc, n_hevc_heights: nHeights,
           hevc_measured: hevcOk };
}

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
    out.fit = fitEncode(db);
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
  const fit = R.fit || null;
  let total = 0;
  for (const f of films || []) {
    const dur = (f.duration_s && f.duration_s > 0)
      ? f.duration_s
      : ((f.bytes || 0) * 8) / (NOMINAL_MBPS * 1e6);
    if (!dur) continue;
    let enc;
    // rungs: [{codec,height}] gives the two-term model. codecs: ['h264',...]
    // is the legacy shape and still works, on the old blended rate - a caller
    // that cannot say which rungs it wants gets the old accuracy, not a guess.
    if (fit && f.rungs && f.rungs.length) {
      const L = pixelLoad(f.rungs);
      enc = dur * (fit.base + fit.h264 * L.h264 + fit.hevc * L.hevc);
    } else {
      const both = (f.codecs || []).indexOf('hevc') !== -1 && (f.codecs || []).indexOf('h264') !== -1;
      const rate = both ? R.both : R.h264;
      enc = dur / (rate || FALLBACK.h264);
    }
    // Outputs are smaller than the source; measured across the ladder they
    // come to roughly half the master. Used only when the caller cannot know.
    const ob = (f.out_bytes != null) ? f.out_bytes : (f.bytes || 0) * 0.5;
    total += enc * (1 + R.verify)
           + ((f.bytes || 0) / 1e6) / (R.fetch_mbps || FALLBACK.fetch_mbps)
           + (ob / 1e6) / (R.upload_mbps || FALLBACK.upload_mbps);
  }
  // The band narrows with the model. A 6.7% held-out error does not deserve the
  // same width as a 38.6% one. Still ASYMMETRIC: a film already at its
  // destination is skipped and finishes instantly, so a run can land well under
  // the low end and can never land far above the high one for that reason.
  const modelled = !!(R.fit);
  const lo = modelled ? 0.85 : 0.80;
  const hi = modelled ? 1.25 : 1.25;
  return { seconds: total, low: total * lo, high: total * hi, rates: R,
           modelled: modelled,
           hevc_provisional: !!(R.fit && !R.fit.hevc_measured) };
}

function words(sec) {
  if (!sec || sec <= 0) return '—';
  const h = sec / 3600;
  if (h < 1) return Math.round(sec / 60) + ' min';
  if (h < 10) return h.toFixed(1) + ' h';
  return Math.round(h) + ' h';
}
function range(e) { return words(e.low) + ' to ' + words(e.high); }

module.exports = { rates, estimate, words, range, pixelLoad, fitEncode,
                   NOMINAL_MBPS, PX };
