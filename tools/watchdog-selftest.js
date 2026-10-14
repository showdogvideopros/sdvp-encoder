'use strict';
// tools/watchdog-selftest.js — proves each watchdog alarm fires on its known-positive
// and stays quiet on its known-negative (2026-10-14).
//
// Runs the REAL tools/watchdog.js as a child process, against synthetic state files
// in a temp folder, with emails captured to a file (WATCHDOG_SINK) instead of sent.
// It never touches the live state.json, the live watchdog.json, or the encoder.
// What it does NOT prove: that SendGrid delivers (that is `watchdog.js --test`).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const WD = path.join(__dirname, 'watchdog.js');
const T = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-selftest-'));
const STATE = path.join(T, 'state.json'), DB = path.join(T, 'watchdog.json');
const JOBS = path.join(T, 'jobs'), SINK = path.join(T, 'sink.txt');
fs.mkdirSync(JOBS);
const MIN = 60000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

function item(id, name, phase, extra) {
  return Object.assign({ item_id: id, name, phase, progress: { pct: 40, label: phase.toLowerCase() }, error: null }, extra || {});
}
// History: one finished run with an old failure (must never email after seeding)
const history = { run_id: 'r1021', run_number: 1021, job_label: 'OLD JOB', status: 'COMPLETE',
  started_at: iso(30 * 24 * 60 * MIN), finished_at: iso(29 * 24 * 60 * MIN),
  items: [item(1, 'OLD FILM A', 'DONE'), item(2, 'OLD FILM B', 'FAILED', { error: 'old failure' })] };
function active(phases) {
  return { run_id: 'r1023', run_number: 1023, job_label: 'TEST SHOW', status: 'RUNNING',
    started_at: iso(60 * MIN), finished_at: null,
    items: phases.map((p, i) => item(100 + i, 'TEST FILM ' + (i + 1), p[0], p[1])) };
}
function writeState(runs, ageMs) { fs.writeFileSync(STATE, JSON.stringify({ updated_at: iso(ageMs), runs })); }

let sinkSeen = 0;
function run(env, args) {
  const r = spawnSync(process.execPath, [WD, ...(args || [])], {
    encoding: 'utf8', timeout: 30000,
    env: Object.assign({}, process.env, {
      WATCHDOG_STATE_FILE: STATE, WATCHDOG_DB: DB, WATCHDOG_JOBS_DIR: JOBS, WATCHDOG_SINK: SINK,
      WATCHDOG_FAKE_ACTIVE: 'active', WATCHDOG_FAKE_ENABLED: 'enabled',
      WATCHDOG_HEARTBEAT_HOUR: '99', SENDGRID_API_KEY: ''
    }, env || {})
  });
  if (r.status !== 0) console.log('    (watchdog exit ' + r.status + ') ' + (r.stderr || '').trim());
  const all = fs.existsSync(SINK) ? fs.readFileSync(SINK, 'utf8') : '';
  const fresh = all.slice(sinkSeen); sinkSeen = all.length;
  return (fresh.match(/^=== \[[^\]]+\] .*$/gm) || []).map(s => s.replace(/^=== \[[^\]]+\] /, ''));
}

const results = [];
function expect(name, got, re) {
  const pass = re === null ? got.length === 0 : (got.length === 1 && re.test(got[0]));
  results.push(pass);
  console.log((pass ? '  PASS  ' : '  FAIL  ') + name + ' — ' + (got.length ? got.join(' | ') : '(no email)'));
}

console.log('── WATCHDOG SELF-TEST ── (temp ' + T + ')');
// A. first run arms: one "armed" email, history marked seen
writeState([history], 1 * MIN);
expect('A first run arms once', run(), /^Watchdog armed$/);
expect('A2 old failure does not email', run(), null);

// B/C. stall known-negative then known-positive
writeState([active([['DONE'], ['FETCHING'], ['QUEUED']]), history], 1 * MIN);
expect('B active, status 1 min old: quiet', run(), null);
writeState([active([['DONE'], ['FETCHING'], ['QUEUED']]), history], 25 * MIN);
expect('C status 25 min old: STALLED', run(), /^STALLED: TEST FILM 2$/);
expect('C2 next check: no repeat yet', run(), null);
expect('C3 after repeat interval: STILL STALLED', run({ WATCHDOG_REPEAT_MIN: '0' }), /^STILL STALLED/);
writeState([active([['DONE'], ['ENCODING'], ['QUEUED']]), history], 0);
expect('D progress again: MOVING AGAIN', run(), /^MOVING AGAIN$/);
expect('D2 then quiet', run(), null);

// E. a film fails
writeState([active([['DONE'], ['FAILED', { error: 'download stalled: no data for 120 s' }], ['FETCHING']]), history], 0);
expect('E film fails: FAILED names it', run(), /^FAILED: TEST FILM 2$/);
expect('E2 not repeated', run(), null);

// F. the run finishes; the already-reported failure is not reported as new
const done = active([['DONE'], ['FAILED', { error: 'download stalled' }], ['DONE']]);
done.finished_at = iso(0); done.status = 'COMPLETE';
writeState([done, history], 0);
expect('F run finishes: RUN FINISHED with failure count', run(), /^RUN FINISHED with 1 failed - TEST SHOW$/);
expect('F2 not repeated', run(), null);

// G. service down: known-negative (disabled on purpose) then known-positive
expect('G disabled + stopped on purpose: quiet', run({ WATCHDOG_FAKE_ACTIVE: 'inactive', WATCHDOG_FAKE_ENABLED: 'disabled' }), null);
expect('G2 enabled but failed, first sighting: waits', run({ WATCHDOG_FAKE_ACTIVE: 'failed' }), null);
expect('G3 still down past the limit: DOWN', run({ WATCHDOG_FAKE_ACTIVE: 'failed', WATCHDOG_DOWN_MIN: '0' }), /^DOWN - /);
expect('G4 back up: RUNNING AGAIN', run(), /^RUNNING AGAIN/);

// H. a job file waiting with nothing starting
const jf = path.join(JOBS, '20261014T000000_TEST.json');
fs.writeFileSync(jf, '{}');
expect('H job waiting 0 min: quiet', run(), null);
const old = (Date.now() - 15 * MIN) / 1000; fs.utimesSync(jf, old, old);
expect('H2 job waiting 15 min: NOT STARTING', run(), /^NOT STARTING/);
expect('H3 not repeated', run(), null);
fs.rmSync(jf);

// I. morning heartbeat while there is work (heartbeat hour forced to now)
const hourNow = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
writeState([active([['ENCODING'], ['QUEUED']]), done, history], 0);
expect('I morning, work present: STILL ALIVE', run({ WATCHDOG_HEARTBEAT_HOUR: String(hourNow) }), /^Still alive/);
expect('I2 only once a day', run({ WATCHDOG_HEARTBEAT_HOUR: String(hourNow) }), null);

fs.rmSync(T, { recursive: true, force: true });
const pass = results.every(Boolean);
console.log(pass ? '── ALL PASS (' + results.length + ')' : '── FAILED (' + results.filter(x => !x).length + ' of ' + results.length + ')');
process.exit(pass ? 0 : 1);
