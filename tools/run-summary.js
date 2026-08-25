'use strict';
// RUN SUMMARY - the fast read. One screen, mid-run or after.
//
// The full run report carries audio verdicts, contact sheets and per-rung
// verify times. This is the other thing: did the films come out the size the
// ladder intended, did anything fail, and what is the ratio.
//
// ⛔ PREDICTIONS ARE COMPUTED FROM THE LIVE PRESET, never from constants typed
// in here. If the reserve or a rate changes and this file keeps its own copy,
// it reports drift that is not there and misses drift that is.
//
// Usage:  node tools/run-summary.js [run_number]
//         no argument = the newest run
const fs = require('fs');
const { loadEnv } = require('/root/build/lib/env.js');
loadEnv({ quiet: true });
const R = require('/root/build/lib/record.js');

const CEIL = 4 * 1024 * 1024 * 1024;
const RESERVE = 0.95;              // must match lib/orchestrator.js
const FLOORS = { h264: 3500, hevc: 2500 };
const OVERHEAD = 1.032;            // [MEASURED 2026-08-23] container on top of a+v

// What the ladder INTENDED for this rung on a film of this length. Mirrors the
// derivation in lib/orchestrator.js. Returns null when the preset has no rate
// for that height, i.e. the rung is not rate-targeted.
function intended(presetName, codec, height, durS) {
  let P;
  try { P = JSON.parse(fs.readFileSync('/root/build/presets/' + presetName + '.json', 'utf8')); }
  catch (e) { return null; }
  const spec = (P.rungs || []).find(x => Number(x.height) === Number(height));
  if (!spec || !spec.rate_kbps) return null;
  let rate = Number(spec.rate_kbps);
  if (Number(height) === 1080 && FLOORS[codec] && durS > 0) {
    const total = (CEIL * 8 / durS / 1000) * RESERVE;
    const video = Math.floor(total - Number(spec.audio_kbps || 0));
    rate = Math.min(rate, video);
    if (rate < FLOORS[codec]) return { refused: true };
  }
  return { rate: rate,
           bytes: ((rate + Number(spec.audio_kbps || 0)) * 1000 * durS / 8) * OVERHEAD };
}

const f = (n, d) => (n == null ? '-' : Number(n).toFixed(d == null ? 1 : d));
const gb = b => (b == null ? '-' : (b / 1073741824).toFixed(2));

const want = process.argv[2] ? Number(process.argv[2]) : null;
const run = want
  ? R.query('SELECT * FROM runs WHERE run_number = ?', [want])[0]
  : R.query('SELECT * FROM runs ORDER BY started_at DESC LIMIT 1')[0];
if (!run) { console.log('no such run'); process.exit(1); }

const ms = R.query('SELECT * FROM movies WHERE run_id = ?', [run.run_id]);
const live = !run.finished_at;
console.log('');
console.log('  RUN ' + run.run_number + '   ' + run.status + (live ? '   ← IN FLIGHT' : ''));
console.log('  ' + String(run.job_label).slice(0, 62));
console.log('  ' + run.started_at + (run.finished_at ? '  →  ' + run.finished_at : ''));
console.log('');
console.log('    min  phase    files   out GB   mach   ratio  film');
console.log('  ' + '─'.repeat(74));

let src = 0, srcB = 0, out = 0, mach = 0, nDone = 0, nFail = 0;
const drift = [];
const notes = [];

ms.sort((a, b) => (a.source_name || '').localeCompare(b.source_name || '')).forEach(m => {
  const t = (m.fetch_s||0) + (m.encode_s||0) + (m.verify_s||0) + (m.upload_s||0);
  const rg = R.query('SELECT * FROM rungs WHERE item_id = ? ORDER BY codec, height DESC', [m.item_id]);
  const b = rg.reduce((a, r) => a + (r.bytes || 0), 0);
  const stored = rg.filter(r => r.state === 'STORED').length;
  if (m.phase === 'DONE') { nDone++; src += (m.duration_s||0); srcB += (m.source_bytes||0);
                            out += b; mach += t; }
  if (m.phase === 'FAILED') nFail++;
  console.log('  ' + f(m.duration_s/60).padStart(6) + '  ' + String(m.phase).padEnd(8)
    + String(stored).padStart(4) + '   ' + gb(b).padStart(7) + '  ' + f(t/60,0).padStart(5) + 'm'
    + (m.duration_s ? f(t/m.duration_s,2) : '   -').padStart(7) + '  '
    + String(m.source_name).replace(/\.mp4$/i,'').slice(0,28));
  if (m.error) notes.push('FAILED  ' + String(m.source_name).slice(0,30) + ' — ' + String(m.error).slice(0,60));
  rg.forEach(r => {
    if (r.state === 'SKIPPED') notes.push('skipped ' + r.height + 'p ' + r.codec + '  '
      + String(m.source_name).replace(/\.mp4$/i,'').slice(0,26) + ' — ' + String(r.reason).slice(0,52));
    if (r.state !== 'STORED' || !r.bytes) return;
    const want = intended(r.preset_name, r.codec, r.height, m.duration_s);
    if (!want || want.refused || !want.bytes) return;
    const pctOff = 100 * (r.bytes - want.bytes) / want.bytes;
    if (Math.abs(pctOff) > 6) drift.push('  ' + r.height + 'p ' + String(r.codec).padEnd(5)
      + gb(r.bytes) + ' GB actual vs ' + gb(want.bytes) + ' predicted  '
      + (pctOff>0?'+':'') + f(pctOff,0) + '%   ' + String(m.source_name).slice(0,26));
    if (r.bytes > CEIL) notes.push('⛔ OVER 4 GiB  ' + r.height + 'p ' + r.codec + '  '
      + gb(r.bytes) + ' GB  ' + String(m.source_name).slice(0,30));
  });
});

console.log('  ' + '─'.repeat(74));
// THE RECORD ONLY KNOWS FILMS IT HAS WRITTEN. A film still queued has no row,
// so ms.length is NOT the job's film count mid-run - it would read "4 of 4" on
// a 22-film job. The daemon's live state carries the real total.
let planned = ms.length;
try {
  const st = JSON.parse(require('fs').readFileSync('/var/lib/sdvp-encoder/state.json','utf8'));
  const lr = (st.runs || []).find(x => Number(x.run_number) === Number(run.run_number));
  if (lr && (lr.items || []).length) planned = lr.items.length;
} catch (e) {}
console.log('  ' + nDone + ' of ' + planned + ' films done'
  + (planned > ms.length ? '   (' + (planned - ms.length) + ' not started)' : '')
  + (nFail ? '   ⛔ ' + nFail + ' FAILED' : '   no failures'));
if (nDone) {
  console.log('  source  ' + gb(srcB) + ' GB   ' + f(src/3600,2) + ' h');
  console.log('  output  ' + gb(out) + ' GB   (' + f(100*out/srcB,0) + '% of masters)');
  console.log('  machine ' + f(mach/3600,2) + ' h   ratio ' + f(mach/src,2) + 'x'
    + (live ? '   ← projection, run still in flight' : ''));
  if (run.finished_at) {
    const wall = (new Date(run.finished_at) - new Date(run.started_at))/3600;
    console.log('  wall    ' + f(wall/1000,2) + ' h   idle '
      + f(wall/1000 - mach/3600,2) + ' h');
  }
} else {
  console.log('  nothing finished yet - the record writes as each film completes');
}
if (drift.length) {
  console.log('');
  console.log('  ⚠ FILES MORE THAN 6% OFF THEIR PREDICTED SIZE');
  drift.forEach(d => console.log(d));
}
if (notes.length) {
  console.log('');
  console.log('  NOTES');
  notes.forEach(n => console.log('   ' + n));
}
if (!drift.length && !notes.length && nDone) {
  console.log('');
  console.log('  every file within 6% of its predicted size, nothing skipped, nothing over 4 GiB');
}
console.log('');
