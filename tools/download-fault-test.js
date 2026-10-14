'use strict';
// tools/download-fault-test.js — live test for F1 (D-ENC-FETCH-ABORT-HANGS), 2026-10-14
//
// Runs the REAL download() against the REAL pCloud, using the self-test's own
// shakedown file, and injects two faults at 50 MB into the live socket:
//   cut   - the socket is destroyed mid-body (the Sep 16 shape: body ends early)
//   stall - the socket stops delivering bytes (nothing arrives, nothing closes)
//
// Usage (env file loaded so the pCloud token is present):
//   node tools/download-fault-test.js                 # tests lib/pcloud.js (the fix)
//   node tools/download-fault-test.js --old <module>  # control: the pre-fix backup
//
// Expectations are named before the run:
//   fixed code : 1 completes · 2 REJECTS fast · 3 REJECTS after the idle limit
//                · 4 (cut once, under withRetry) COMPLETES on a later attempt
//   --old      : 1 completes · 2 STILL PENDING at its time budget (Sep 16 reproduced)
// Set SDVP_DOWNLOAD_IDLE_MS (e.g. 10000) to keep test 3 short.
const fs = require('fs');
const path = require('path');
const https = require('https');

const OLD = process.argv.includes('--old');
const modArg = process.argv.filter(a => !a.startsWith('--')).slice(2)[0];
const MOD = path.resolve(modArg || '/root/build/lib/pcloud.js');
const SELFTEST = '/root/build/tools/pcloud-selftest.js';

const m = fs.readFileSync(SELFTEST, 'utf8').match(/SHAKEDOWN\s*=\s*['"]?(\d+)/);
if (!m) { console.log('REFUSED: no SHAKEDOWN fileid found in ' + SELFTEST); process.exit(2); }
const FILEID = Number(m[1]);

const DIR = '/var/lib/sdvp-encoder/scratch';
fs.mkdirSync(DIR, { recursive: true });
const DEST = path.join(DIR, 'faulttest-' + process.pid + '.bin');
const FAULT_AT = 50 * 1024 * 1024;
const IDLE_MS = Number(process.env.SDVP_DOWNLOAD_IDLE_MS) || 120000;

// Fault injector: wraps https.get. pcloud.js calls https.get(url-string, cb) for
// the file body and https.get(options-object, cb) for API calls, so only the body
// request (a string URL) is touched, and only while a fault is armed.
let plan = null;   // { kind: 'cut' | 'stall', times: n }
const origGet = https.get;
https.get = function (...a) {
  const req = origGet.apply(this, a);
  if (typeof a[0] === 'string' && plan && plan.times > 0) {
    const p = plan;
    req.on('response', (res) => {
      let n = 0, fired = false;
      res.on('data', (c) => {
        n += c.length;
        if (!fired && n >= FAULT_AT && p.times > 0) {
          fired = true; p.times--; p.fired = (p.fired || 0) + 1;
          if (p.kind === 'cut') req.socket.destroy();
          else req.socket.pause();
        }
      });
    });
  }
  return req;
};

const pc = require(MOD);

function clean() { try { fs.rmSync(DEST, { force: true }); } catch (_) {} }

async function timed(fn, budgetMs) {
  const t = Date.now();
  let timer;
  const r = await Promise.race([
    fn().then(x => ({ ok: true, x }), e => ({ ok: false, e })),
    new Promise(res => { timer = setTimeout(() => res({ pending: true }), budgetMs); })
  ]);
  clearTimeout(timer);
  r.s = ((Date.now() - t) / 1000).toFixed(1);
  return r;
}

function show(r) {
  if (r.pending) return 'STILL PENDING after ' + r.s + ' s';
  if (r.ok) return 'COMPLETED ' + r.x.bytes + ' bytes in ' + r.s + ' s';
  return 'REJECTED in ' + r.s + ' s: ' + r.e.message;
}

(async () => {
  const meta = await pc.stat(FILEID);
  console.log('── DOWNLOAD FAULT TEST ──');
  console.log('  module   ' + MOD + (OLD ? '   (CONTROL: expect a hang)' : ''));
  console.log('  file     ' + meta.name + '  ' + meta.size + ' bytes');
  console.log('  fault at ' + FAULT_AT + ' bytes · idle limit ' + (IDLE_MS / 1000) + ' s');
  const results = [];
  const rec = (name, pass, r) => { results.push(pass); console.log((pass ? '  PASS  ' : '  FAIL  ') + name + ' — ' + show(r)); };

  // 1. known-negative: no fault, must complete whole
  plan = null; clean();
  let r = await timed(() => pc.download(FILEID, DEST, null, null), 300000);
  rec('1 no fault: completes, full size', r.ok && r.x.bytes === meta.size, r);

  // 2. cut mid-body
  plan = { kind: 'cut', times: 1 }; clean();
  r = await timed(() => pc.download(FILEID, DEST, null, null), 30000);
  if (OLD) rec('2 cut at 50 MB (old code): hangs', !!r.pending && plan.fired === 1, r);
  else     rec('2 cut at 50 MB: rejects fast', r.ok === false && plan.fired === 1 && Number(r.s) < 20, r);

  if (!OLD) {
    // 3. stall mid-body
    plan = { kind: 'stall', times: 1 }; clean();
    r = await timed(() => pc.download(FILEID, DEST, null, null), IDLE_MS + 30000);
    rec('3 stall at 50 MB: rejects after idle limit',
        r.ok === false && plan.fired === 1 && /stalled/.test(r.e.message), r);

    // 4. cut once, under the same withRetry the encoder uses
    plan = { kind: 'cut', times: 1 }; clean();
    r = await timed(() => pc.withRetry('fetch', () => pc.download(FILEID, DEST, null, null),
                                       n => console.log('        retry note: ' + n)), 300000);
    rec('4 cut once under withRetry: recovers, full size',
        r.ok && r.x.bytes === meta.size && plan.fired === 1, r);
  }

  clean();
  const pass = results.every(Boolean);
  console.log(pass ? '── ALL PASS (' + results.length + ')' : '── FAILED');
  process.exit(pass ? 0 : 1);
})().catch(e => { clean(); console.log('ERROR ' + e.message); process.exit(1); });
